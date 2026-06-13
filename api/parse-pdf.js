// api/parse-pdf.js
// Vercel serverless function: haalt Gmail PDF op en parset via Anthropic
 
const https = require('https');
 
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
 
// Genereer een Google OAuth2 access token via service account (JWT)
async function getGoogleAccessToken() {
  const { createSign } = require('crypto');
 
  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
    sub: 'adverteren@nieuws.nl'  // impersoneer adverteren@nieuws.nl
  };
 
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claim)).toString('base64url');
  const unsigned = `${header}.${payload}`;
 
  const sign = createSign('RSA-SHA256');
  sign.update(unsigned);
  const signature = sign.sign(serviceAccount.private_key, 'base64url');
  const jwt = `${unsigned}.${signature}`;
 
  const tokenBody = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  const result = await httpsRequest({
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(tokenBody) }
  }, tokenBody);
 
  if (result.status !== 200) throw new Error('Token fout: ' + JSON.stringify(result.body));
  return result.body.access_token;
}
 
module.exports = async function handler(req, res) {
  // CORS voor n8n
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
 
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Alleen POST' });
 
  const { messageId } = req.body;
  if (!messageId) return res.status(400).json({ error: 'messageId vereist' });
 
  try {
    // Stap 1: Google access token ophalen
    const accessToken = await getGoogleAccessToken();
    const user = 'adverteren%40nieuws.nl';
 
    // Stap 2: mail detail ophalen (geeft verse attachmentId)
    const detailResp = await httpsRequest({
      hostname: 'gmail.googleapis.com',
      path: `/gmail/v1/users/${user}/messages/${messageId}?format=full`,
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (detailResp.status !== 200) return res.status(502).json({ error: 'Gmail detail fout', detail: detailResp.body });
 
    const msg = detailResp.body;
 
    // AM-naam parsen uit snippet
    const GELDIGE_AMS = ['Dolf Verschuren', 'Mark Peeters', 'Serge Klaassen', 'Leo Christiaens', 'Chatura Pijs', 'Paul Storms'];
    const snippet = msg.snippet || '';
    const amMatch = snippet.match(/salesmedewerker ([A-Z][a-z]+ [A-Z][a-z]+)/);
    const amNaam = (amMatch && GELDIGE_AMS.includes(amMatch[1])) ? amMatch[1] : 'Onbekend';
 
    // PDF-bijlage zoeken
    function findPdf(parts) {
      if (!parts) return null;
      for (const p of parts) {
        if (p.mimeType === 'application/pdf' && p.body?.attachmentId) return p;
        if (p.parts) { const f = findPdf(p.parts); if (f) return f; }
      }
      return null;
    }
    const pdfPart = findPdf(msg.payload?.parts);
    if (!pdfPart) return res.json({ amNaam, klantNaam: '(geen PDF)', totaal: 0 });
 
    // Stap 3: bijlage ophalen (verse ID, direct na detail-call)
    const attResp = await httpsRequest({
      hostname: 'gmail.googleapis.com',
      path: `/gmail/v1/users/${user}/messages/${messageId}/attachments/${pdfPart.body.attachmentId}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (attResp.status !== 200) return res.status(502).json({ error: 'Bijlage fout', detail: attResp.body });
 
    const pdfData = (attResp.body.data || '').replace(/-/g, '+').replace(/_/g, '/');
    if (!pdfData) return res.json({ amNaam, klantNaam: '(lege bijlage)', totaal: 0 });
 
    // Stap 4: Anthropic parset de PDF
    const claudeBody = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      messages: [{ role: 'user', content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfData } },
        { type: 'text', text: 'Extract from this plaatsingsovereenkomst and return ONLY valid JSON no markdown: {"klantNaam": string, "totaal": number excl BTW as integer}' }
      ]}]
    });
    const claudeResp = await httpsRequest({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(claudeBody)
      }
    }, claudeBody);
 
    if (claudeResp.status !== 200) return res.status(502).json({ error: 'Anthropic fout', detail: claudeResp.body });
 
    const tekst = claudeResp.body.content?.[0]?.text || '{}';
    const parsed = JSON.parse(tekst.replace(/```json|```/g, '').trim());
 
    return res.json({
      amNaam,
      klantNaam: parsed.klantNaam || '(onbekend)',
      totaal: parsed.totaal || 0
    });
 
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
