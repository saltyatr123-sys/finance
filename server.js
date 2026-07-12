const express = require('express')
const twilio = require('twilio')

const app = express()
app.use(express.urlencoded({ extended: false }))
app.use(express.json())

// ── Firebase config ──────────────────────────────────────────────────────────
const FIREBASE_API_KEY = 'AIzaSyDVIXeJk7H1x09ybCq0tJce0kk6VelcgO4'
const PROJECT_ID = 'salty-finance'
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`

// ── Firestore helpers ─────────────────────────────────────────────────────────
function toFirestoreFields(obj) {
  const fields = {}
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'number')  fields[k] = { doubleValue: v }
    else                        fields[k] = { stringValue: String(v) }
  }
  return fields
}

async function fsAdd(col, data) {
  const res = await fetch(`${FIRESTORE_BASE}/${col}?key=${FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFirestoreFields(data) }),
  })
  return res.json()
}

async function fsGet(col) {
  const res = await fetch(`${FIRESTORE_BASE}/${col}?key=${FIREBASE_API_KEY}`)
  const json = await res.json()
  return (json.documents || []).map((d) => {
    const out = {}
    for (const [k, v] of Object.entries(d.fields || {})) {
      out[k] = v.doubleValue ?? v.stringValue ?? v.integerValue ?? null
    }
    return out
  })
}

// ── Message parser ────────────────────────────────────────────────────────────
function extractAmount(text) {
  const match = text.match(/\d+(\.\d+)?/)
  return match ? parseFloat(match[0]) : null
}

function today() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jerusalem' }).slice(0, 10)
}

function thisMonth() {
  return today().slice(0, 7)
}

const EXPENSE_WORDS = ['שילמתי', 'קניתי', 'הוצאה', 'תשלום', 'עלה לי', 'עלה', 'הוצאת', 'הוצאות']
const INCOME_WORDS  = ['מכרתי', 'קיבלתי', 'הכנסה', 'מכירה', 'נכנס', 'נכנסו', 'מכר']

function detectType(text) {
  const t = text
  if (EXPENSE_WORDS.some((w) => t.includes(w))) return 'expense'
  if (INCOME_WORDS.some((w) => t.includes(w)))  return 'income'
  return null
}

function detectSource(text) {
  if (/שופיפ/.test(text)) return 'shopify'
  if (/פופ.?אפ|popup/.test(text)) return 'popup'
  return 'other'
}

// ── Commands ──────────────────────────────────────────────────────────────────
async function cmdInventory() {
  const items = await fsGet('inventory')
  if (!items.length) return '📦 אין מוצרים במלאי עדיין.'
  let msg = '📦 *מלאי נוכחי:*\n\n'
  for (const item of items) {
    if (!item.sizes) continue
    let sizes
    try { sizes = JSON.parse(item.sizes) } catch { continue }
    const lines = sizes.map((s) => `${s.size}: ${s.stock} יח'`).join(' | ')
    msg += `*${item.name}*\n${lines}\n\n`
  }
  return msg.trim()
}

async function cmdReport() {
  const month = thisMonth()
  const [incomes, expenses] = await Promise.all([fsGet('income'), fsGet('expenses')])

  const monthIncome   = incomes.filter((i) => String(i.date).startsWith(month)).reduce((s, i) => s + Number(i.amount), 0)
  const monthExpenses = expenses.filter((e) => String(e.date).startsWith(month)).reduce((s, e) => s + Number(e.amount), 0)
  const profit        = monthIncome - monthExpenses

  const monthHe = new Date().toLocaleString('he-IL', { month: 'long', year: 'numeric', timeZone: 'Asia/Jerusalem' })

  return (
    `📊 *דוח ${monthHe}*\n\n` +
    `💚 הכנסות: ₪${monthIncome.toLocaleString()}\n` +
    `🔴 הוצאות: ₪${monthExpenses.toLocaleString()}\n` +
    `──────────────\n` +
    `${profit >= 0 ? '✅' : '⚠️'} רווח נטו: ₪${profit.toLocaleString()}`
  )
}

function cmdHelp() {
  return (
    `🧂 *Salty Bot — פקודות:*\n\n` +
    `*הכנסה:*\n"מכרתי חולצה M 150"\n"קיבלתי 200 פופאפ"\n\n` +
    `*הוצאה:*\n"שילמתי שופיפי 90"\n"קניתי מלאי 500"\n\n` +
    `*פקודות מהירות:*\n📦 *מלאי* — סיכום מלאי\n📊 *דוח* — סיכום החודש\n❓ *עזרה* — ההודעה הזו`
  )
}

// ── Main handler ──────────────────────────────────────────────────────────────
async function processMessage(text) {
  const t = text.trim()

  if (t === 'מלאי')                          return cmdInventory()
  if (t === 'דוח')                           return cmdReport()
  if (['עזרה', '?', 'help'].includes(t))     return cmdHelp()

  const amount = extractAmount(t)
  if (!amount) {
    return `לא הבנתי 🤔\n\nשלח "עזרה" לרשימת פקודות.`
  }

  const type = detectType(t)
  if (!type) {
    return (
      `לא ברור אם זו הכנסה או הוצאה.\n\n` +
      `נסה:\n"*מכרתי* חולצה 150" (הכנסה)\n"*שילמתי* לספק 300" (הוצאה)`
    )
  }

  const date = today()

  if (type === 'income') {
    const source = detectSource(t)
    await fsAdd('income', {
      amount,
      description: t,
      date,
      category: 'מכירת מוצרים',
      source,
    })
    const sourceLabel = source === 'shopify' ? ' (שופיפי)' : source === 'popup' ? ' (פופאפ)' : ''
    return `✅ *נרשמה הכנסה${sourceLabel}*\n₪${amount.toLocaleString()} — ${date}\n"${t}"`
  }

  if (type === 'expense') {
    const category = /שופיפ/.test(t) ? 'עמלות שופיפי'
      : /פרסו|מטא|meta|אינסטה|טיקטוק/.test(t) ? 'שיווק ופרסום'
      : /ספק|מלאי|חולצ|סוודר/.test(t) ? 'רכישת מלאי'
      : /משלוח/.test(t) ? 'משלוחים'
      : 'אחר'

    await fsAdd('expenses', {
      amount,
      description: t,
      date,
      category,
    })
    return `✅ *נרשמה הוצאה*\n₪${amount.toLocaleString()} — ${date}\nקטגוריה: ${category}\n"${t}"`
  }
}

// ── Route ─────────────────────────────────────────────────────────────────────
app.post('/whatsapp', async (req, res) => {
  const text = req.body.Body || ''
  let reply

  try {
    reply = await processMessage(text)
  } catch (err) {
    console.error(err)
    reply = '⚠️ שגיאה פנימית. נסה שוב.'
  }

  const twiml = new twilio.twiml.MessagingResponse()
  twiml.message(reply)
  res.type('text/xml').send(twiml.toString())
})

app.get('/', (_, res) => res.send('Salty Bot is running 🧂'))

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`Salty Bot listening on port ${PORT}`))
