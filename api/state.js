// Função serverless da Vercel: guarda e entrega o cronograma.
// GET  /api/state                -> público (o cliente usa)
// POST /api/state {action:'check'}       -> valida a senha do gerente
// POST /api/state {rev, state}           -> publica uma atualização (exige senha)
const crypto = require('crypto');

const KEY = 'cronograma:di-leticia-lucca';
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmd) {
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

function samePassword(given, expected) {
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(String(expected || '')).digest();
  return crypto.timingSafeEqual(a, b);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);

function clean(s) {
  if (!s || typeof s !== 'object') return null;
  const projeto = str(s.projeto, 120), cliente = str(s.cliente ?? '', 120);
  if (projeto === null || cliente === null) return null;
  if (typeof s.atualizadoEm !== 'string' || !DATE.test(s.atualizadoEm)) return null;
  if (!Array.isArray(s.ambientes) || s.ambientes.length > 30) return null;
  if (!Array.isArray(s.notas) || s.notas.length > 300) return null;
  const ambientes = [];
  for (const a of s.ambientes) {
    const id = str(a && a.id, 40), nome = str(a && a.nome, 80);
    if (!id || !nome) return null;
    if (!Number.isInteger(a.fase) || a.fase < 0 || a.fase > 4) return null;
    if (!Array.isArray(a.datas) || a.datas.length !== 4) return null;
    if (!a.datas.every(d => d === '' || (typeof d === 'string' && DATE.test(d)))) return null;
    ambientes.push({ id, nome, fase: a.fase, datas: a.datas });
  }
  const notas = [];
  for (const n of s.notas) {
    const id = str(n && n.id, 40), texto = str(n && n.texto, 4000);
    if (!id || texto === null || typeof n.semana !== 'string' || !DATE.test(n.semana)) return null;
    notas.push({ id, semana: n.semana, texto });
  }
  return { projeto, cliente, exemplo: !!s.exemplo, atualizadoEm: s.atualizadoEm, ambientes, notas };
}

module.exports = async function handler(req, res) {
  if (!URL_ || !TOKEN) return send(res, 500, { error: 'Banco de dados não configurado na Vercel (Upstash Redis).' });
  try {
    if (req.method === 'GET') {
      const raw = await redis(['GET', KEY]);
      return send(res, 200, raw ? JSON.parse(raw) : { rev: 0, state: null });
    }
    if (req.method === 'POST') {
      if (!process.env.MANAGER_PASSWORD) return send(res, 500, { error: 'MANAGER_PASSWORD não configurada na Vercel.' });
      if (!samePassword(req.headers['x-manager-password'], process.env.MANAGER_PASSWORD)) {
        await new Promise(r => setTimeout(r, 600));
        return send(res, 401, { error: 'Senha incorreta.' });
      }
      let body = req.body;
      if (typeof body === 'string') body = JSON.parse(body);
      if (body && body.action === 'check') return send(res, 200, { ok: true });
      const state = clean(body && body.state);
      if (!state) return send(res, 400, { error: 'Dados inválidos.' });
      const raw = await redis(['GET', KEY]);
      const current = raw ? JSON.parse(raw) : { rev: 0 };
      if (Number(body.rev) !== current.rev) return send(res, 409, { error: 'Conflito de versão.' });
      const next = { rev: current.rev + 1, state };
      await redis(['SET', KEY, JSON.stringify(next)]);
      return send(res, 200, { ok: true, rev: next.rev });
    }
    res.setHeader('Allow', 'GET, POST');
    return send(res, 405, { error: 'Método não permitido.' });
  } catch (e) {
    return send(res, 500, { error: 'Erro no servidor.' });
  }
};
