require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const {
  MPESA_CONSUMER_KEY,
  MPESA_CONSUMER_SECRET,
  MPESA_SHORTCODE,
  MPESA_PASSKEY,
  MPESA_ENV,        // "sandbox" or "production"
  CALLBACK_URL,      // your public https URL + /api/callback
  PORT
} = process.env;

const BASE_URL = MPESA_ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

// In-memory store of payment results, keyed by CheckoutRequestID.
// Fine for a small single-instance app; swap for a real DB if you scale up.
const payments = new Map();

function timestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

async function getAccessToken() {
  const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
  const { data } = await axios.get(
    `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } }
  );
  return data.access_token;
}

// Kick off an STK push (the "enter M-Pesa PIN" prompt on the payer's phone).
app.post('/api/stkpush', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!/^2547\d{8}$/.test(phone)) {
      return res.status(400).json({ error: 'Phone must be in the format 2547XXXXXXXX' });
    }

    const token = await getAccessToken();
    const ts = timestamp();
    const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${ts}`).toString('base64');

    const { data } = await axios.post(
      `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
      {
        BusinessShortCode: MPESA_SHORTCODE,
        Password: password,
        Timestamp: ts,
        TransactionType: 'CustomerPayBillOnline',
        Amount: 10,
        PartyA: phone,
        PartyB: MPESA_SHORTCODE,
        PhoneNumber: phone,
        CallBackURL: CALLBACK_URL,
        AccountReference: 'PrepaidBulb',
        TransactionDesc: 'Bulb top-up'
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );

    payments.set(data.CheckoutRequestID, { status: 'pending' });
    res.json({ checkoutRequestId: data.CheckoutRequestID });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Could not start the payment. Check server logs.' });
  }
});

// Safaricom calls this URL directly (not the browser) once the payer responds.
app.post('/api/callback', (req, res) => {
  const result = req.body?.Body?.stkCallback;
  if (result) {
    const success = result.ResultCode === 0;
    payments.set(result.CheckoutRequestID, {
      status: success ? 'paid' : 'failed',
      resultDesc: result.ResultDesc
    });
  }
  res.json({ received: true });
});

// The browser polls this to find out if the phone owner approved the prompt.
app.get('/api/status/:checkoutRequestId', (req, res) => {
  const record = payments.get(req.params.checkoutRequestId);
  if (!record) return res.status(404).json({ status: 'unknown' });
  res.json(record);
});

const port = PORT || 3000;
app.listen(port, () => console.log(`Prepaid bulb running on port ${port}`));
