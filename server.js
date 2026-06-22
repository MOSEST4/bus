/**
 * Bus Fare System Proxy Server
 * Handles MarzPay, Firebase, and RFID operations
 * Global Coaches Bus, Mbarara — BSU Final Year Project
 * Students: Tukamuhebwa Annet & Donath Gration
 */

const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
const PROXY_SECRET = process.env.PROXY_SECRET || 'bus_fare_proxy_2026_secret_key';

// MarzPay
const MARZPAY_BASE = 'https://wallet.wearemarz.com/api/v1';
const MARZPAY_AUTH = 'bWFyel9TTmdZMHRwb1FVcFk1WmNoOndIRWdTT0lhUjhCUjNMMDV2NlZFUHFzMTBOZFdNZzU4';
const MIN_AMOUNT = 500;

// EgoSMS
const EGO_SMS_USERNAME = 'INFINITECH';
const EGO_SMS_PASSWORD = 'Moses,123##';
const EGO_SMS_SENDER = 'INFINITECH';
const EGO_SMS_BASE = 'https://www.egosms.co/api/v1/plain/';

// Firebase
const FIREBASE_PROJECT_ID = 'final-yearprojects';
const FARE_AMOUNT = 5000; // UGX per trip

// OTP store
const otpStore = {};

// ═══════════════════════════════════════════════════════════════════════════
// FIREBASE INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════

// Initialize with service account (you'll need to add serviceAccountKey.json)
// OR use Firebase REST API (no credentials needed for public Firestore)
const useFirebaseAdmin = false; // Set to true if you have service account

if (useFirebaseAdmin && process.env.FIREBASE_SERVICE_ACCOUNT) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: `https://${FIREBASE_PROJECT_ID}.firebaseio.com`
  });
}

const db = useFirebaseAdmin ? admin.firestore() : null;

// ═══════════════════════════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════════

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Proxy-Key, Authorization');
  res.header('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Auth (except health check)
app.use((req, res, next) => {
  if (req.path === '/health' || req.path === '/') return next();
  
  const key = req.headers['x-proxy-key'];
  if (key !== PROXY_SECRET) {
    return res.status(403).json({ status: 'error', message: 'Unauthorized' });
  }
  next();
});

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

function normalizePhone(raw) {
  let p = (raw || '').replace(/[\s\-\(\)]/g, '');
  // Remove any leading zeros
  p = p.replace(/^0+/, '');
  // Remove any duplicate country code (e.g., 256256 -> 256)
  if (p.startsWith('256256')) p = p.substring(3);
  // Add + if not present
  if (p.startsWith('256')) return '+' + p;
  // If it's just the local number (7XX...), add +256
  if (p.startsWith('7') || p.startsWith('3') || p.startsWith('4')) return '+256' + p;
  // Default: assume it's missing country code
  if (!p.startsWith('+')) return '+256' + p;
  return p;
}

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendSms(phone, message) {
  // EgoSMS: remove + from phone number
  phone = phone.replace('+', '');
  console.log(`[SMS] Sending to ${phone} via EgoSMS`);
  
  try {
    const url = `${EGO_SMS_BASE}?number=${phone}&message=${encodeURIComponent(message)}&username=${EGO_SMS_USERNAME}&password=${encodeURIComponent(EGO_SMS_PASSWORD)}&sender=${EGO_SMS_SENDER}`;
    
    const r = await axios.get(url, { timeout: 10000 });
    console.log(`[SMS] EgoSMS response: ${r.status} ${r.data}`);
    return r.status === 200;
  } catch (e) {
    console.error('[SMS] EgoSMS error:', e.response?.data ?? e.message);
    return false;
  }
}

// Firestore REST API helper (no credentials needed!)
async function firestoreGet(collection, docId) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}/${docId}`;
  try {
    const r = await axios.get(url);
    const fields = r.data.fields || {};
    // Convert Firestore format to simple object
    const data = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value.stringValue !== undefined) data[key] = value.stringValue;
      else if (value.integerValue !== undefined) data[key] = parseInt(value.integerValue);
      else if (value.doubleValue !== undefined) data[key] = parseFloat(value.doubleValue);
      else if (value.booleanValue !== undefined) data[key] = value.booleanValue;
    }
    return data;
  } catch (e) {
    if (e.response?.status === 404) return null;
    throw e;
  }
}

async function firestoreSet(collection, docId, data) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}/${docId}`;
  
  // Convert to Firestore format
  const fields = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string') fields[key] = { stringValue: value };
    else if (typeof value === 'number') {
      if (Number.isInteger(value)) fields[key] = { integerValue: String(value) };
      else fields[key] = { doubleValue: value };
    }
    else if (typeof value === 'boolean') fields[key] = { booleanValue: value };
    else if (value instanceof Date) fields[key] = { timestampValue: value.toISOString() };
  }
  
  try {
    await axios.patch(url + '?updateMask.fieldPaths=' + Object.keys(data).join('&updateMask.fieldPaths='), 
      { fields },
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    console.error('[Firestore SET] Error:', e.response?.data ?? e.message);
    throw e;
  }
}

async function firestoreAdd(collection, data) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}`;
  
  const fields = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string') fields[key] = { stringValue: value };
    else if (typeof value === 'number') {
      if (Number.isInteger(value)) fields[key] = { integerValue: String(value) };
      else fields[key] = { doubleValue: value };
    }
    else if (typeof value === 'boolean') fields[key] = { booleanValue: value };
    else if (value instanceof Date) fields[key] = { timestampValue: value.toISOString() };
  }
  
  try {
    await axios.post(url, { fields }, {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    console.error('[Firestore ADD] Error:', e.response?.data ?? e.message);
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// Health check
app.get('/health', async (req, res) => {
  try {
    const r = await axios.get('https://api.ipify.org?format=json', { timeout: 5000 });
    res.json({
      status: 'ok',
      service: 'Bus Fare Proxy',
      outgoing_ip: r.data.ip,
      firebase_project: FIREBASE_PROJECT_ID,
      message: '🚌 Global Coaches Bus Fare System'
    });
  } catch {
    res.json({ status: 'ok', service: 'Bus Fare Proxy' });
  }
});

app.get('/', (req, res) => {
  res.json({
    name: 'Bus Fare System Proxy',
    version: '1.0.0',
    project: 'Global Coaches Bus, Mbarara',
    students: 'Tukamuhebwa Annet & Donath Gration',
    university: 'Bishop Stuart University',
    endpoints: [
      'POST /process-tap - Arduino RFID tap handler',
      'POST /initiate-topup - Start mobile money collection',
      'GET /topup-status/:uuid - Check payment status',
      'POST /send-otp - Send SMS OTP',
      'POST /verify-otp - Verify OTP code',
      'GET /health - Health check'
    ]
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. PROCESS TAP (Arduino)
// ═══════════════════════════════════════════════════════════════════════════

app.post('/process-tap', async (req, res) => {
  try {
    const { card_uid, bus_id, route_id, fare_amount } = req.body;

    if (!card_uid) {
      return res.status(400).json({ success: false, error: 'card_uid required' });
    }

    console.log(`[TAP] Card: ${card_uid} | Bus: ${bus_id}`);

    // Get card from Firestore
    const card = await firestoreGet('cards', card_uid);

    if (!card) {
      console.log(`[TAP] Card not registered: ${card_uid}`);
      return res.json({
        success: false,
        error: 'Card not registered',
        message: 'Please register this card first'
      });
    }

    const currentBalance = card.balance || 0;
    const fare = fare_amount || FARE_AMOUNT;

    // Check balance
    if (currentBalance < fare) {
      console.log(`[TAP] Insufficient balance: ${currentBalance} < ${fare}`);
      return res.json({
        success: false,
        error: 'Insufficient balance',
        current_balance: currentBalance,
        fare_required: fare,
        message: 'Balance too low. Please top up.'
      });
    }

    // Deduct fare
    const newBalance = currentBalance - fare;
    const tripCount = (card.trip_count || 0) + 1;

    await firestoreSet('cards', card_uid, {
      balance: newBalance,
      last_used: new Date().toISOString(),
      trip_count: tripCount
    });

    // Log transaction
    await firestoreAdd('transactions', {
      card_uid,
      student_name: card.student_name || 'Unknown',
      student_id: card.student_id || '',
      type: 'fare_deduction',
      amount: -fare,
      balance_before: currentBalance,
      balance_after: newBalance,
      bus_id: bus_id || 'Unknown',
      route_id: route_id || 'Unknown',
      timestamp: new Date().toISOString(),
      created_at: new Date().toISOString()
    });

    console.log(`[TAP] Success! ${currentBalance} → ${newBalance}`);

    // Send SMS if low balance
    if (newBalance < 10000 && card.phone_number) {
      const phone = normalizePhone(card.phone_number);
      const msg = `Bus fare deducted: UGX ${fare}. New balance: UGX ${newBalance.toLocaleString()}. ${newBalance < 5000 ? 'LOW BALANCE! Please top up.' : ''}`;
      sendSms(phone, msg).catch(e => console.error('[SMS] Failed:', e));
    }

    return res.json({
      success: true,
      message: 'Fare deducted successfully',
      new_balance: newBalance,
      fare_deducted: fare,
      trips_remaining: Math.floor(newBalance / fare)
    });

  } catch (error) {
    console.error('[TAP] Error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. VERIFY PHONE (Check if registered with MarzPay)
// ═══════════════════════════════════════════════════════════════════════════

app.post('/verify-phone', async (req, res) => {
  try {
    const { phone_number } = req.body;
    
    if (!phone_number) {
      return res.status(400).json({
        status: 'error',
        message: 'phone_number required'
      });
    }
    
    const phone = normalizePhone(phone_number).replace('+', ''); // MarzPay wants no +
    
    console.log('[VERIFY-PHONE] Checking:', phone);
    
    const response = await axios.post(
      `${MARZPAY_BASE}/phone-verification/verify`,
      { phone_number: phone },
      {
        headers: {
          'Authorization': `Basic ${MARZPAY_AUTH}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );
    
    console.log('[VERIFY-PHONE] Response:', response.data);
    return res.json(response.data);
    
  } catch (error) {
    console.error('[VERIFY-PHONE] Error:', error.response?.data ?? error.message);
    return res.json({
      status: 'error',
      message: error.response?.data?.message || 'Phone verification failed'
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. INITIATE TOP-UP
// ═══════════════════════════════════════════════════════════════════════════

app.post('/initiate-topup', async (req, res) => {
  try {
    const { card_uid, phone_number, amount } = req.body;

    if (!card_uid || !phone_number || !amount) {
      return res.status(400).json({
        status: 'error',
        message: 'card_uid, phone_number, and amount required'
      });
    }

    if (amount < MIN_AMOUNT) {
      return res.json({
        status: 'error',
        message: `Minimum top-up is UGX ${MIN_AMOUNT}`
      });
    }

    // Verify card exists
    const card = await firestoreGet('cards', card_uid);
    if (!card) {
      return res.status(404).json({
        status: 'error',
        message: 'Card not found'
      });
    }

    const phone = normalizePhone(phone_number);
    // MarzPay requires UUID format for reference
    const { randomUUID } = require('crypto');
    const reference = randomUUID();

    console.log(`[TOPUP] Initiating top-up:`);
    console.log(`  - Card UID: ${card_uid}`);
    console.log(`  - Phone: ${phone}`);
    console.log(`  - Amount: ${amount} UGX`);
    console.log(`  - Reference (UUID): ${reference}`);

    // Call MarzPay
    const params = new URLSearchParams();
    params.append('phone_number', phone);
    params.append('amount', String(amount));
    params.append('country', 'UG');
    params.append('reference', reference);
    params.append('description', `Bus Fare Top-Up - ${card.student_name || card_uid}`);

    console.log('[TOPUP] Calling MarzPay API...');
    console.log(`  - URL: ${MARZPAY_BASE}/collect-money`);
    console.log(`  - Params: ${params.toString()}`);

    const marzResponse = await axios.post(
      `${MARZPAY_BASE}/collect-money`,
      params.toString(),
      {
        headers: {
          'Authorization': `Basic ${MARZPAY_AUTH}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        },
        timeout: 30000
      }
    );

    const data = marzResponse.data;
    console.log(`[TOPUP] MarzPay Response:`);
    console.log(JSON.stringify(data, null, 2));

    // Store pending transaction
    if (data.status === 'success' && data.uuid) {
      await firestoreSet('pending_topups', data.uuid, {
        card_uid,
        phone_number: phone,
        amount,
        reference,
        uuid: data.uuid,
        status: 'pending',
        created_at: new Date().toISOString()
      });
    }

    return res.json(data);

  } catch (error) {
    console.error('[TOPUP] ❌ ERROR:');
    console.error('  - Message:', error.message);
    console.error('  - Response:', error.response?.data);
    console.error('  - Status:', error.response?.status);
    console.error('  - Stack:', error.stack);
    return res.json({
      status: 'error',
      message: error.response?.data?.message || error.message
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. CHECK TOP-UP STATUS
// ═══════════════════════════════════════════════════════════════════════════

app.get('/topup-status/:uuid', async (req, res) => {
  try {
    const { uuid } = req.params;

    console.log(`[STATUS] Checking: ${uuid}`);

    // Check MarzPay
    const marzResponse = await axios.get(
      `${MARZPAY_BASE}/collect-money/${uuid}`,
      {
        headers: { 'Authorization': `Basic ${MARZPAY_AUTH}` },
        timeout: 15000
      }
    );

    const data = marzResponse.data;
    console.log(`[STATUS] MarzPay: ${data.status}`);

    // If successful, update balance
    if (data.status === 'success') {
      const pending = await firestoreGet('pending_topups', uuid);

      if (pending && pending.status === 'pending') {
        const card = await firestoreGet('cards', pending.card_uid);
        const newBalance = (card.balance || 0) + pending.amount;

        // Update card balance
        await firestoreSet('cards', pending.card_uid, {
          balance: newBalance
        });

        // Log transaction
        await firestoreAdd('transactions', {
          card_uid: pending.card_uid,
          student_name: card.student_name || 'Unknown',
          type: 'top_up',
          amount: pending.amount,
          phone_number: pending.phone_number,
          reference: pending.reference,
          uuid: uuid,
          timestamp: new Date().toISOString(),
          created_at: new Date().toISOString()
        });

        // Mark completed
        await firestoreSet('pending_topups', uuid, {
          status: 'completed',
          completed_at: new Date().toISOString()
        });

        console.log(`[STATUS] Top-up completed! +${pending.amount}`);

        // Send SMS
        const msg = `Top-up successful! UGX ${pending.amount.toLocaleString()} added. New balance: UGX ${newBalance.toLocaleString()}. - Global Coaches`;
        sendSms(pending.phone_number, msg).catch(e => console.error('[SMS] Failed:', e));
      }
    }

    return res.json(data);

  } catch (error) {
    console.error('[STATUS] Error:', error.response?.data ?? error.message);
    return res.json({
      status: 'error',
      message: error.response?.data?.message || error.message
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. SEND OTP
// ═══════════════════════════════════════════════════════════════════════════

app.post('/send-otp', async (req, res) => {
  try {
    const { phone, amount, description } = req.body;

    if (!phone) {
      return res.json({ success: false, message: 'Phone required' });
    }

    const normalizedPhone = normalizePhone(phone);
    const code = generateOtp();

    otpStore[normalizedPhone] = {
      code,
      expiry: Date.now() + 120000 // 2 min
    };

    console.log(`[OTP] Code for ${normalizedPhone}: ${code}`);

    const message = amount
      ? `Your Global Coaches verification code for UGX ${amount} ${description || 'transaction'} is ${code}. Valid 2 minutes. Do NOT share.`
      : `Your Global Coaches verification code is ${code}. Valid 2 minutes. Do NOT share.`;

    await sendSms(normalizedPhone, message);

    return res.json({
      success: true,
      message: 'OTP sent to your phone'
    });

  } catch (error) {
    console.error('[OTP] Error:', error);
    return res.json({
      success: false,
      message: error.message
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. VERIFY OTP
// ═══════════════════════════════════════════════════════════════════════════

app.post('/verify-otp', async (req, res) => {
  try {
    const { phone, code } = req.body;
    const normalizedPhone = normalizePhone(phone);

    const entry = otpStore[normalizedPhone];

    if (!entry) {
      return res.json({
        success: false,
        message: 'No OTP found. Request a new one.'
      });
    }

    if (Date.now() > entry.expiry) {
      delete otpStore[normalizedPhone];
      return res.json({
        success: false,
        message: 'OTP expired. Request a new one.'
      });
    }

    if (entry.code !== (code || '').trim()) {
      return res.json({
        success: false,
        message: 'Incorrect OTP'
      });
    }

    delete otpStore[normalizedPhone];

    return res.json({
      success: true,
      message: 'OTP verified successfully'
    });

  } catch (error) {
    console.error('[VERIFY-OTP] Error:', error);
    return res.json({
      success: false,
      message: error.message
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// KEEP-ALIVE (prevent free tier sleep)
// ═══════════════════════════════════════════════════════════════════════════

setInterval(() => {
  const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  axios.get(`${url}/health`).catch(() => {});
}, 14 * 60 * 1000); // Every 14 minutes

// ═══════════════════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log('🚀 Bus Fare Proxy Server Running');
  console.log(`📡 Port: ${PORT}`);
  console.log(`🔥 Firebase: ${FIREBASE_PROJECT_ID}`);
  console.log(`💰 MarzPay: Enabled`);
  console.log(`📱 EgoSMS: Enabled`);
  console.log(`🚌 Global Coaches Bus, Mbarara`);
  console.log(`🎓 BSU Final Year Project 2026`);
});
