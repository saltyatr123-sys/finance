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

// Handles stringValue, doubleValue, integerValue, booleanValue, arrayValue, mapValue
function extractValue(v) {
  if (!v) return null
  if ('stringValue'  in v) return v.stringValue
  if ('doubleValue'  in v) return v.doubleValue
  if ('integerValue' in v) return Number(v.integerValue)
  if ('booleanValue' in v) return v.booleanValue
  if ('arrayValue'   in v) {
    return (v.arrayValue.values || []).map((item) => {
      if ('mapValue' in item) {
        const obj = {}
        for (const [k, vv] of Object.entries(item.mapValue.fields || {})) {
          obj[k] = extractValue(vv)
        }
        return obj
      }
      return extractValue(item)
    })
  }
  if ('mapValue' in v) {
    const obj = {}
    for (const [k, vv] of Object.entries(v.mapValue.fields || {})) {
      obj[k] = extractValue(vv)
    }
    return obj
  }
  return null
}

function toFirestoreFields(obj) {
  const fields = {}
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'number') fields[k] = { doubleValue: v }
    else                       fields[k] = { stringValue: String(v) }
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
      out[k] = extractValue(v)
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

// Parse sizes whether stored as JSON string or native array
function parseSizes(raw) {
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return [] }
  }
  return []
}

// ── Message parser ────────────────────────────────────────────────────────────

function extractAmount(text) {
  const matches = [...text.matchAll(/\d+(\.\d+)?/g)]
  if (!matches.length) return null
  return parseFloat(matches[matches.length - 1][0])
}

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
  if (/שופיפ/.test(text))          return 'shopify'
  if (/פופ.?אפ|popup/.test(text))  return 'popup'
  if (/ביט|bit/i.test(text))       return 'bit'
  if (/מזומן|cash/i.test(text))    return 'cash'
  if (/העברה|בנק/.test(text))      return 'bank'
  return 'other'
}

// ── Inventory matching ────────────────────────────────────────────────────────

function detectProductType(text) {
  if (/חולצ/.test(text))           return 'חולצ'
  if (/סוודר|סווד|פוטר/.test(text)) return 'פוטר'
  if (/מכנס/.test(text))           return 'מכנס'
  return null
}

function detectSize(text) {
  const match = text.match(/\b(XXL|XL|XS|XXS|S|M|L)\b/i)
  return match ? match[1].toUpperCase() : null
}

function extractBuyer(text) {
  const match = text.match(/ל([א-ת]{2,10})(?:\s|$)/)
  return match ? match[1] : ''
}

function detectColorHint(text) {
  if (/נייבי|נייווי/.test(text)) return 'נייבי'
  if (/חום/.test(text))           return 'חום'
  if (/קהה/.test(text))           return 'קהה'
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

  if (size) {
    const withStock = candidates.filter((item) => {
      const sizes = parseSizes(item.sizes)
      return sizes.some((s) => s.size === size && s.stock > 0)
    })
    return { product: withStock.length ? withStock[0] : candidates[0], size }
  }

  return { product: candidates[0], size: null }
}

// Decrement inventory stock and optionally update sellPrice
async function decrementInventory(product, size, sellPrice, qty) {
  if (!product || !size) return null
  const sizes = parseSizes(product.sizes)
  const idx = sizes.findIndex((s) => s.size === size)
  if (idx === -1) return null

  if (sellPrice > 0) sizes[idx].sellPrice = sellPrice
  sizes[idx].stock = Math.max(0, sizes[idx].stock - qty)

  await fsPatch('inventory', product._id, { sizes: JSON.stringify(sizes) })
  return { name: product.name, size, newStock: sizes[idx].stock }
}

// Increment inventory stock on purchase
async function incrementInventory(product, size, qty) {
  if (!product || !size) return null
  const sizes = parseSizes(product.sizes)
  const idx = sizes.findIndex((s) => s.size === size)
  if (idx === -1) return null

  sizes[idx].stock += qty

  await fsPatch('inventory', product._id, { sizes: JSON.stringify(sizes) })
  return { name: product.name, size, newStock: sizes[idx].stock }
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdInventory() {
  const items = await fsGet('inventory')
  if (!items.length) return '📦 אין מוצרים במלאי עדיין.'
  let msg = '📦 *מלאי נוכחי:*\n\n'
  for (const item of items) {
    const sizes = parseSizes(item.sizes)
    if (!sizes.length) continue
    const lines = sizes.map((s) => `${s.size}: ${s.stock} יח'`).join(' | ')
    const total = sizes.reduce((sum, s) => sum + (s.stock || 0), 0)
    msg += `*${item.name}*\n${lines}\nסה"כ: ${total} יח'\n\n`
  }
  return msg.trim()
}

async function cmdReport() {
  const month = thisMonth()
  const [incomes, expenses] = await Promise.all([fsGet('income'), fsGet('expenses')])

  const SKIP = ['הון עצמי', 'התאמה']
  const monthIncome   = incomes
    .filter((i) => String(i.date).startsWith(month) && !SKIP.includes(i.category))
    .reduce((s, i) => s + Number(i.amount), 0)
  const monthExpenses = expenses
    .filter((e) => String(e.date).startsWith(month))
    .reduce((s, e) => s + Number(e.amount), 0)
  const profit = monthIncome - monthExpenses

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
    `*הכנסה:*\n"מכרתי חולצה M 150"\n"מכרתי סוודר L לטל 200"\n"קיבלתי 200 ביט"\n\n` +
    `*כמות:*\n"מכרתי 2 חולצות M 150" (2 יחידות)\n\n` +
    `*הוצאה:*\n"שילמתי שופיפי 90"\n"קניתי מלאי 500"\n\n` +
    `*פקודות מהירות:*\n📦 *מלאי* — סיכום מלאי\n📊 *דוח* — סיכום החודש\n❓ *עזרה* — ההודעה הזו`
  )
}

// ── Main handler ──────────────────────────────────────────────────────────────

async function processMessage(text) {
  const t = text.trim()

  if (t === 'מלאי')                      return cmdInventory()
  if (t === 'דוח')                       return cmdReport()
  if (['עזרה', '?', 'help'].includes(t)) return cmdHelp()

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
    const qty    = extractQuantity(t)
    const buyer  = extractBuyer(t)

    // Find product first so we can include in the income entry
    const { product, size } = await findInventoryProduct(t)
    const productName = product?.name || ''

    await fsAdd('income', {
      amount: amount * qty,
      description: t,
      date,
      category: 'מכירת מוצרים',
      source,
      buyer,
      product: productName,
      size: size || '',
    })

    const srcHe = { shopify: 'שופיפי', popup: 'פופאפ', bit: 'ביט', cash: 'מזומן', bank: 'העברה' }[source] || ''
    let reply = `✅ *נרשמה הכנסה${srcHe ? ' (' + srcHe + ')' : ''}*\n₪${(amount * qty).toLocaleString()} — ${date}`
    if (qty > 1) reply += ` (${qty} יח' × ₪${amount})`
    if (buyer)   reply += `\nקונה: ${buyer}`
    reply += `\n"${t}"`

    const invUpdate = await decrementInventory(product, size, amount, qty)
    if (invUpdate) {
      reply += `\n\n📦 *מלאי עודכן:*\n${invUpdate.name} ${invUpdate.size} → נשארו ${invUpdate.newStock} יח'`
    }

    return reply
  }

  if (type === 'expense') {
    const category = /שופיפ/.test(t)              ? 'עמלות שופיפי'
      : /פרסו|מטא|meta|אינסטה|טיקטוק/.test(t)   ? 'שיווק ופרסום'
      : /ספק|מלאי|חולצ|סוודר|מכנס/.test(t)      ? 'רכישת מלאי'
      : /משלוח/.test(t)                            ? 'משלוחים'
      : 'אחר'

    const qty = extractQuantity(t)

    await fsAdd('expenses', {
      amount,
      description: t,
      date,
      category,
    })

    let reply = `✅ *נרשמה הוצאה*\n₪${amount.toLocaleString()} — ${date}\nקטגוריה: ${category}\n"${t}"`

    if (category === 'רכישת מלאי') {
      const { product, size } = await findInventoryProduct(t)
      const invUpdate = await incrementInventory(product, size, qty)
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

// ── Shopify webhook ───────────────────────────────────────────────────────────

app.post('/shopify-order', async (req, res) => {
  res.sendStatus(200) // respond immediately so Shopify doesn't retry

  try {
    const order = req.body
    if (!order || !order.total_price) return

    const amount = parseFloat(order.total_price)
    if (!amount) return

    const orderNumber = order.order_number || order.name || 'ללא מספר'
    const lineItems   = order.line_items || []
    const date        = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jerusalem' }).slice(0, 10)

    // Extract buyer name
    const buyer = [order.customer?.first_name, order.customer?.last_name]
      .filter(Boolean).join(' ') || order.billing_address?.name || ''

    // Build description
    const itemsText  = lineItems.map((i) => `${i.name} x${i.quantity}`).join(', ')
    const description = `הזמנה #${orderNumber}${itemsText ? ' — ' + itemsText : ''}`

    // Get primary product info for the income entry
    let primaryProduct = ''
    let primarySize    = ''
    if (lineItems.length > 0) {
      const first    = lineItems[0]
      const itemText = first.name || first.product_title || ''
      const size     = first.variant_title?.split('/')?.[0]?.trim() || detectSize(itemText) || ''
      const { product } = await findInventoryProduct(itemText + (size ? ' ' + size : ''))
      primaryProduct = product?.name || first.product_title || itemText.split(' - ')[0]
      primarySize    = size
    }

    await fsAdd('income', {
      amount,
      description,
      date,
      category: 'מכירת מוצרים',
      source: 'shopify',
      buyer,
      product: primaryProduct,
      size: primarySize,
    })

    // Decrement inventory for EACH line item
    for (const item of lineItems) {
      const itemText = item.name || item.product_title || ''
      const size     = item.variant_title?.split('/')?.[0]?.trim() || detectSize(itemText)
      const qty      = item.quantity || 1
      const price    = parseFloat(item.price || 0)

      if (!size) continue
      const { product } = await findInventoryProduct(itemText + ' ' + size)
      const inv = await decrementInventory(product, size, price, qty)
      if (inv) {
        console.log(`  📦 ${inv.name} ${inv.size} → ${inv.newStock} נשארו`)
      }
    }

    console.log(`Shopify הזמנה #${orderNumber} נרשמה: ₪${amount} — ${buyer}`)
  } catch (err) {
    console.error('Shopify webhook error:', err)
  }
})

app.get('/', (_, res) => res.send('Salty Bot is running 🧂'))

const PORT = process.env.PORT || 3001
app.listen(PORT, () => console.log(`Salty Bot listening on port ${PORT}`))
