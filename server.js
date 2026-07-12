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
    const out = { _id: d.name.split('/').pop() }
    for (const [k, v] of Object.entries(d.fields || {})) {
      out[k] = v.doubleValue ?? v.stringValue ?? v.integerValue ?? null
    }
    return out
  })
}

async function fsPatch(col, docId, data) {
  const fields = Object.keys(data).map((k) => `updateMask.fieldPaths=${k}`).join('&')
  const res = await fetch(
    `${FIRESTORE_BASE}/${col}/${docId}?key=${FIREBASE_API_KEY}&${fields}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: toFirestoreFields(data) }),
    }
  )
  return res.json()
}

// ── Message parser ────────────────────────────────────────────────────────────

// Returns the LAST number (most likely the price, not quantity)
function extractAmount(text) {
  const matches = [...text.matchAll(/\d+(\.\d+)?/g)]
  if (!matches.length) return null
  return parseFloat(matches[matches.length - 1][0])
}

// Returns the FIRST number if there are 2+ numbers (likely quantity)
function extractQuantity(text) {
  const matches = [...text.matchAll(/\d+/g)]
  return matches.length >= 2 ? parseInt(matches[0][0]) : 1
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
  if (EXPENSE_WORDS.some((w) => text.includes(w))) return 'expense'
  if (INCOME_WORDS.some((w) => text.includes(w)))  return 'income'
  return null
}

function detectSource(text) {
  if (/שופיפ/.test(text)) return 'shopify'
  if (/פופ.?אפ|popup/.test(text)) return 'popup'
  return 'other'
}

// ── Inventory matching ────────────────────────────────────────────────────────
function detectProductType(text) {
  if (/חולצ/.test(text)) return 'חולצ'
  if (/סוודר|סווד/.test(text)) return 'סוודר'
  return null
}

function detectSize(text) {
  const match = text.match(/\b(XXL|XL|XS|XXS|S|M|L)\b/i)
  return match ? match[1].toUpperCase() : null
}

function detectColorHint(text) {
  if (/נייבי|נייווי/.test(text)) return 'נייבי'
  if (/חום/.test(text)) return 'חום'
  if (/קהה/.test(text)) return 'קהה'
  return null
}

async function findInventoryProduct(text) {
  const productType = detectProductType(text)
  if (!productType) return { product: null, size: null }

  const size = detectSize(text)
  const colorHint = detectColorHint(text)
  const items = await fsGet('inventory')

  let candidates = items.filter((item) => item.name && item.name.includes(productType))
  if (colorHint) {
    const withColor = candidates.filter((item) => item.color && item.color.includes(colorHint))
    if (withColor.length) candidates = withColor
  }
  if (!candidates.length) return { product: null, size }

  // Prefer product with stock in that size (for sales)
  if (size) {
    const withStock = candidates.filter((item) => {
      try {
        const sizes = JSON.parse(item.sizes || '[]')
        return sizes.some((s) => s.size === size && s.stock > 0)
      } catch { return false }
    })
    return { product: withStock.length ? withStock[0] : candidates[0], size }
  }

  return { product: candidates[0], size: null }
}

async function updateInventoryOnSale(text, amount, qty) {
  const { product, size } = await findInventoryProduct(text)
  if (!product || !size) return null

  let sizes
  try { sizes = JSON.parse(product.sizes || '[]') } catch { return null }

  const sizeIdx = sizes.findIndex((s) => s.size === size)
  if (sizeIdx === -1) return null

  sizes[sizeIdx].sellPrice = amount
  sizes[sizeIdx].stock = Math.max(0, sizes[sizeIdx].stock - qty)

  await fsPatch('inventory', product._id, { sizes: JSON.stringify(sizes) })

  return { name: product.name, size, newStock: sizes[sizeIdx].stock }
}

async function updateInventoryOnPurchase(text, qty) {
  const { product, size } = await findInventoryProduct(text)
  if (!product || !size) return null

  let sizes
  try { sizes = JSON.parse(product.sizes || '[]') } catch { return null }

  const sizeIdx = sizes.findIndex((s) => s.size === size)
  if (sizeIdx === -1) return null

  sizes[sizeIdx].stock += qty

  await fsPatch('inventory', product._id, { sizes: JSON.stringify(sizes) })

  return { name: product.name, size, newStock: sizes[sizeIdx].stock }
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
    const totalStock = sizes.reduce((sum, s) => sum + s.stock, 0)
    msg += `*${item.name}*\n${lines}\nסה"כ: ${totalStock} יח'\n\n`
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
    `*הכנסה:*\n"מכרתי חולצה M 150"\n"מכרתי סוודר L 200"\n"קיבלתי 200 פופאפ"\n\n` +
    `*כמות:*\n"מכרתי 2 חולצות M 150" (2 יחידות)\n\n` +
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
    const qty = extractQuantity(t)

    await fsAdd('income', {
      amount: amount * qty,
      description: t,
      date,
      category: 'מכירת מוצרים',
      source,
    })

    const sourceLabel = source === 'shopify' ? ' (שופיפי)' : source === 'popup' ? ' (פופאפ)' : ''
    let reply = `✅ *נרשמה הכנסה${sourceLabel}*\n₪${(amount * qty).toLocaleString()} — ${date}`
    if (qty > 1) reply += ` (${qty} יח' × ₪${amount})`
    reply += `\n"${t}"`

    // Update inventory: set sellPrice + decrease stock
    const invUpdate = await updateInventoryOnSale(t, amount, qty)
    if (invUpdate) {
      reply += `\n\n📦 *מלאי עודכן:*\n${invUpdate.name} ${invUpdate.size} → נשארו ${invUpdate.newStock} יח'`
    }

    return reply
  }

  if (type === 'expense') {
    const category = /שופיפ/.test(t) ? 'עמלות שופיפי'
      : /פרסו|מטא|meta|אינסטה|טיקטוק/.test(t) ? 'שיווק ופרסום'
      : /ספק|מלאי|חולצ|סוודר/.test(t) ? 'רכישת מלאי'
      : /משלוח/.test(t) ? 'משלוחים'
      : 'אחר'

    const qty = extractQuantity(t)

    await fsAdd('expenses', {
      amount,
      description: t,
      date,
      category,
    })

    let reply = `✅ *נרשמה הוצאה*\n₪${amount.toLocaleString()} — ${date}\nקטגוריה: ${category}\n"${t}"`

    // If it's an inventory purchase, update stock
    if (category === 'רכישת מלאי') {
      const invUpdate = await updateInventoryOnPurchase(t, qty)
      if (invUpdate) {
        reply += `\n\n📦 *מלאי עודכן:*\n${invUpdate.name} ${invUpdate.size} → נשארו ${invUpdate.newStock} יח'`
      }
    }

    return reply
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
