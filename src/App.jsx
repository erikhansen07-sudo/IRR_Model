import { useState, useCallback } from 'react'

// ─── Helpers ───────────────────────────────────────────────────────────────
const fmt = {
  currency: v => v == null || isNaN(v) ? '—' : '$' + Math.round(v).toLocaleString(),
  pct: v => v == null || isNaN(v) ? '—' : (v * 100).toFixed(1) + '%',
  mult: v => v == null || isNaN(v) ? '—' : v.toFixed(2) + 'x',
  num: v => v == null || isNaN(v) ? '—' : Number(v).toLocaleString(),
  psf: v => v == null || isNaN(v) ? '—' : '$' + v.toFixed(2),
}

function irr(cashflows, guess = 0.1) {
  let rate = guess
  for (let i = 0; i < 200; i++) {
    let npv = 0, dnpv = 0
    for (let j = 0; j < cashflows.length; j++) {
      const pv = Math.pow(1 + rate, j)
      npv += cashflows[j] / pv
      dnpv -= (j * cashflows[j]) / (pv * (1 + rate))
    }
    const next = rate - npv / dnpv
    if (Math.abs(next - rate) < 1e-8) return isFinite(next) ? next : null
    rate = next
  }
  return null
}

function calcPMT(rate, nper, pv) {
  if (rate === 0) return pv / nper
  return (pv * rate * Math.pow(1 + rate, nper)) / (Math.pow(1 + rate, nper) - 1)
}

function calcLoanBalance(rate, nper, pv, periods) {
  if (rate === 0) return pv - (pv / nper) * periods
  const monthly = calcPMT(rate, nper, pv)
  return pv * Math.pow(1 + rate, periods) - monthly * ((Math.pow(1 + rate, periods) - 1) / rate)
}

function computeMetrics(deal, assumptions) {
  const price = deal.purchasePrice || 0
  const sf = deal.buildingSize || 0
  const rentPSF = deal.rentPSF || 0
  const vacancy = deal.vacancy ?? assumptions.vacancy
  const creditLoss = deal.creditLoss ?? assumptions.creditLoss
  const mgmtFee = deal.mgmtFee ?? assumptions.mgmtFee
  const escalation = deal.escalation ?? assumptions.escalation
  const exitCapPremium = deal.exitCapPremium ?? assumptions.exitCapPremium
  const holdYears = deal.holdYears || 10
  const closingCostPct = deal.closingCostPct ?? assumptions.closingCostPct
  const capexPSF = deal.capexPSF || 0
  const otherIncome = deal.otherIncome || 0
  const ltv = deal.ltv ?? assumptions.ltv
  const interestRate = deal.interestRate ?? assumptions.interestRate
  const amortYears = deal.amortYears ?? assumptions.amortYears
  const loanTermYears = deal.loanTermYears ?? assumptions.loanTermYears

  // Static expenses (annual)
  const propTax = deal.propTax || 0
  const insurance = deal.insurance || 0
  const maintenance = deal.maintenance || 0
  const utilities = deal.utilities || 0
  const landscaping = deal.landscaping || 0
  const reserves = deal.reserves || 0
  const adminExp = deal.adminExp || 0

  // Income
  const gpr = sf * rentPSF
  const egi = (gpr * (1 - vacancy) * (1 - creditLoss)) + otherIncome
  const mgmtFeeAmt = egi * mgmtFee

  // Expenses
  const staticExpenses = propTax + insurance + maintenance + utilities + landscaping + reserves + adminExp
  const totalOpEx = staticExpenses + mgmtFeeAmt
  const noi = egi - totalOpEx
  const expenseRatio = egi > 0 ? totalOpEx / egi : null

  // Acquisition
  const closingCosts = price * closingCostPct
  const totalCapex = capexPSF * sf
  const totalAcqCost = price + closingCosts + totalCapex

  // Entry metrics
  const capRate = price > 0 ? noi / price : null
  const pricePSF = sf > 0 ? price / sf : null
  const noiPSF = sf > 0 ? noi / sf : null
  const grm = gpr > 0 ? price / gpr : null
  const breakEven = gpr > 0 ? totalOpEx / gpr : null

  // Financing
  const loanAmt = price * ltv
  const equity = totalAcqCost - loanAmt
  const monthlyRate = interestRate / 12
  const amortMonths = amortYears * 12
  const annualDS = loanAmt > 0 ? calcPMT(monthlyRate, amortMonths, loanAmt) * 12 : 0
  const dscr = annualDS > 0 ? noi / annualDS : null
  const debtYield = loanAmt > 0 ? noi / loanAmt : null
  const ltv_actual = price > 0 ? loanAmt / price : 0

  // Cash-on-cash
  const coc = equity > 0 ? (noi - annualDS) / equity : null

  // Hold period projections (unlevered)
  const entryCapRate = capRate
  const exitCapRate = entryCapRate != null ? entryCapRate + exitCapPremium : assumptions.exitCapRate

  const unleverCFs = [-totalAcqCost]
  for (let y = 1; y <= holdYears; y++) {
    const yearNOI = noi * Math.pow(1 + escalation, y - 1)
    unleverCFs.push(yearNOI)
  }
  const exitNOI = noi * Math.pow(1 + escalation, holdYears)
  const exitValue = exitCapRate > 0 ? exitNOI / exitCapRate : 0
  unleverCFs[holdYears] += exitValue

  // Levered CFs
  const loanBalance = loanAmt > 0 ? calcLoanBalance(monthlyRate, amortMonths, loanAmt, Math.min(loanTermYears, holdYears) * 12) : 0
  const equityAtExit = exitValue - loanBalance

  const leverCFs = [-equity]
  for (let y = 1; y <= holdYears; y++) {
    const yearNOI = noi * Math.pow(1 + escalation, y - 1)
    leverCFs.push(yearNOI - annualDS)
  }
  leverCFs[holdYears] += equityAtExit

  const irrUnlev = irr(unleverCFs)
  const irrLev = equity > 0 ? irr(leverCFs) : null
  const equityMult = equity > 0 ? equityAtExit / equity : null

  return {
    gpr, egi, mgmtFeeAmt, totalOpEx, noi, expenseRatio,
    closingCosts, totalCapex, totalAcqCost,
    capRate, pricePSF, noiPSF, grm, breakEven,
    loanAmt, equity, annualDS, dscr, debtYield, ltv_actual,
    coc, exitCapRate, exitValue, loanBalance, equityAtExit,
    irrUnlev, irrLev, equityMult,
    unleverCFs, leverCFs
  }
}

// ─── Default Data ──────────────────────────────────────────────────────────
const DEFAULT_ASSUMPTIONS = {
  vacancy: 0.05,
  creditLoss: 0.02,
  mgmtFee: 0.04,
  escalation: 0.03,
  exitCapPremium: 0.005,
  exitCapRate: 0.07,
  closingCostPct: 0.06,
  ltv: 0.65,
  interestRate: 0.065,
  amortYears: 25,
  loanTermYears: 10,
}

const BLANK_DEAL = {
  id: null,
  name: '',
  // A. Property
  address: '', city: '', propertyType: 'Industrial',
  buildingSize: null, landAcres: null, yearBuilt: null,
  clearHeight: '', dockDoors: null, driveInDoors: null,
  officeFinishPct: null, tenantCount: null, zoning: '',
  sprinklered: '', power: null,
  // B. Acquisition
  askingPrice: null, purchasePrice: null,
  earnestMoney: null, capexPSF: null,
  // Override per-deal (null = use global)
  closingCostPct: null,
  // C. Income
  rentPSF: null, otherIncome: null, leaseType: 'NNN',
  leaseExpiration: '', escalation: null, remainingTerm: null,
  // D. Expenses (null = use global)
  vacancy: null, creditLoss: null, mgmtFee: null,
  propTax: null, insurance: null, maintenance: null,
  utilities: null, landscaping: null, reserves: null, adminExp: null,
  // E. Financing (null = use global)
  ltv: null, interestRate: null, amortYears: null, loanTermYears: null,
  // F. Hold
  holdYears: 10, exitCapPremium: null,
  // G. Assessment
  dealScore: null, status: '', brokerNotes: '',
}

let nextId = 1
function newDeal(overrides = {}) {
  return { ...BLANK_DEAL, id: nextId++, name: `Deal ${nextId - 1}`, ...overrides }
}

const SAMPLE_DEALS = [
  newDeal({
    name: 'Beatty Drive', address: '9210 Beatty Drive', city: 'Sacramento, CA',
    propertyType: 'Industrial', buildingSize: 13993, landAcres: 1.02, yearBuilt: 2005,
    clearHeight: "18'-20'", dockDoors: 0, driveInDoors: 5, officeFinishPct: 0.30,
    tenantCount: 1, zoning: 'M-1', sprinklered: 'Yes', power: 400,
    askingPrice: 2400000, purchasePrice: 2400000,
    rentPSF: 10.67, leaseType: 'NNN', leaseExpiration: '12/2028', escalation: 0.03, remainingTerm: 5,
    propTax: null, insurance: null, holdYears: 10,
  }),
  newDeal({
    name: 'Via El Centro', address: '390-398 Via El Centro', city: 'Oceanside, CA',
    propertyType: 'Industrial', buildingSize: 28313, yearBuilt: null,
    clearHeight: "16'", dockDoors: 0, driveInDoors: 8,
    tenantCount: 5, zoning: 'IL',
    askingPrice: 7500000, purchasePrice: 7250000,
    rentPSF: 16.51, leaseType: 'NNN', escalation: 0.03,
    holdYears: 10,
  }),
]

// ─── Components ────────────────────────────────────────────────────────────
const S = {
  app: { display: 'grid', gridTemplateRows: 'auto 1fr', height: '100vh', overflow: 'hidden' },
  header: {
    background: '#151b2e', borderBottom: '1px solid #1e2d4d',
    padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 16
  },
  logo: { color: '#4f8ef7', fontWeight: 700, fontSize: 16, letterSpacing: 1 },
  body: { display: 'grid', gridTemplateColumns: '220px 1fr 280px', overflow: 'hidden' },
  sidebar: { background: '#111827', borderRight: '1px solid #1e2535', overflow: 'auto', padding: 12 },
  main: { overflow: 'auto', padding: 20 },
  panel: { background: '#111827', borderLeft: '1px solid #1e2535', overflow: 'auto', padding: 16 },
  sectionCard: {
    background: '#151b2e', border: '1px solid #1e2535', borderRadius: 8,
    padding: 16, marginBottom: 16
  },
  sectionTitle: {
    fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase',
    color: '#4f8ef7', marginBottom: 12, borderBottom: '1px solid #1e2535', paddingBottom: 6
  },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px' },
  grid3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px 16px' },
  fieldLabel: { fontSize: 11, color: '#718096', marginBottom: 2 },
  metricRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '5px 0', borderBottom: '1px solid #1a2133'
  },
  metricLabel: { color: '#718096', fontSize: 12 },
  metricValue: { fontWeight: 600, fontSize: 13 },
  tag: (color) => ({
    background: color + '22', color, borderRadius: 4, padding: '2px 8px',
    fontSize: 11, fontWeight: 600
  }),
  dealBtn: (active) => ({
    width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 6,
    background: active ? '#1e3a6e' : 'transparent',
    color: active ? '#fff' : '#94a3b8',
    marginBottom: 4, border: active ? '1px solid #2d5cb8' : '1px solid transparent',
    cursor: 'pointer'
  }),
  addBtn: {
    width: '100%', padding: '8px 10px', borderRadius: 6, marginTop: 4,
    background: '#1e3a6e22', color: '#4f8ef7', border: '1px dashed #2d5cb8',
    cursor: 'pointer', fontSize: 12
  },
  metricGood: { color: '#48bb78' },
  metricWarn: { color: '#ecc94b' },
  metricBad: { color: '#fc8181' },
  metricNeutral: { color: '#e2e8f0' },
  deleteBtn: {
    background: 'transparent', color: '#fc8181', fontSize: 11, padding: '2px 6px',
    border: '1px solid #fc818133', borderRadius: 4, cursor: 'pointer', marginLeft: 'auto'
  },
  tab: (active) => ({
    padding: '4px 14px', borderRadius: 4, fontSize: 12, fontWeight: active ? 600 : 400,
    background: active ? '#1e3a6e' : 'transparent', color: active ? '#fff' : '#718096',
    border: 'none', cursor: 'pointer'
  }),
}

function Field({ label, value, onChange, type = 'text', placeholder = '', prefix, suffix, readOnly }) {
  return (
    <div>
      <div style={S.fieldLabel}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        {prefix && <span style={{ color: '#718096', fontSize: 12 }}>{prefix}</span>}
        <input
          type={type}
          value={value ?? ''}
          onChange={onChange ? e => onChange(type === 'number' ? (e.target.value === '' ? null : +e.target.value) : e.target.value) : undefined}
          placeholder={placeholder}
          readOnly={readOnly}
          style={{ ...(readOnly ? { color: '#a0aec0', cursor: 'default' } : {}) }}
        />
        {suffix && <span style={{ color: '#718096', fontSize: 12 }}>{suffix}</span>}
      </div>
    </div>
  )
}

function SelectField({ label, value, onChange, options }) {
  return (
    <div>
      <div style={S.fieldLabel}>{label}</div>
      <select value={value ?? ''} onChange={e => onChange(e.target.value)}>
        <option value="">—</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  )
}

function MetricRow({ label, value, good, warn, suffix = '' }) {
  const color = good ? S.metricGood : warn ? S.metricWarn : S.metricNeutral
  return (
    <div style={S.metricRow}>
      <span style={S.metricLabel}>{label}</span>
      <span style={{ ...S.metricValue, ...color }}>{value}{suffix}</span>
    </div>
  )
}

function AssumptionsPanel({ assumptions, onChange }) {
  const f = (key) => (val) => onChange({ ...assumptions, [key]: val })
  return (
    <div style={{ padding: 16 }}>
      <div style={{ ...S.sectionTitle, marginBottom: 12 }}>Global Assumptions</div>
      <div style={{ color: '#718096', fontSize: 11, marginBottom: 12 }}>
        Per-deal overrides take priority. Leave deal fields blank to use these defaults.
      </div>

      <div style={{ ...S.sectionTitle, fontSize: 10, marginTop: 12 }}>Underwriting</div>
      <div style={{ display: 'grid', gap: 8 }}>
        <Field label="Vacancy %" type="number" value={assumptions.vacancy != null ? +(assumptions.vacancy * 100).toFixed(2) : ''} onChange={v => f('vacancy')(v != null ? v / 100 : null)} suffix="%" />
        <Field label="Credit Loss %" type="number" value={assumptions.creditLoss != null ? +(assumptions.creditLoss * 100).toFixed(2) : ''} onChange={v => f('creditLoss')(v != null ? v / 100 : null)} suffix="%" />
        <Field label="Mgmt Fee % of EGI" type="number" value={assumptions.mgmtFee != null ? +(assumptions.mgmtFee * 100).toFixed(2) : ''} onChange={v => f('mgmtFee')(v != null ? v / 100 : null)} suffix="%" />
        <Field label="Rent Escalation %/yr" type="number" value={assumptions.escalation != null ? +(assumptions.escalation * 100).toFixed(2) : ''} onChange={v => f('escalation')(v != null ? v / 100 : null)} suffix="%" />
        <Field label="Exit Cap Premium" type="number" value={assumptions.exitCapPremium != null ? +(assumptions.exitCapPremium * 100).toFixed(3) : ''} onChange={v => f('exitCapPremium')(v != null ? v / 100 : null)} suffix="%" />
        <Field label="Closing Costs %" type="number" value={assumptions.closingCostPct != null ? +(assumptions.closingCostPct * 100).toFixed(2) : ''} onChange={v => f('closingCostPct')(v != null ? v / 100 : null)} suffix="%" />
      </div>

      <div style={{ ...S.sectionTitle, fontSize: 10, marginTop: 16 }}>Financing</div>
      <div style={{ display: 'grid', gap: 8 }}>
        <Field label="Target LTV %" type="number" value={assumptions.ltv != null ? +(assumptions.ltv * 100).toFixed(1) : ''} onChange={v => f('ltv')(v != null ? v / 100 : null)} suffix="%" />
        <Field label="Interest Rate %" type="number" value={assumptions.interestRate != null ? +(assumptions.interestRate * 100).toFixed(3) : ''} onChange={v => f('interestRate')(v != null ? v / 100 : null)} suffix="%" />
        <Field label="Amortization (yrs)" type="number" value={assumptions.amortYears} onChange={f('amortYears')} />
        <Field label="Loan Term (yrs)" type="number" value={assumptions.loanTermYears} onChange={f('loanTermYears')} />
      </div>
    </div>
  )
}

function DealForm({ deal, assumptions, onChange }) {
  const f = (key) => (val) => onChange({ ...deal, [key]: val })
  const m = computeMetrics(deal, assumptions)

  const scoreColor = (v) => v >= 7 ? S.metricGood : v >= 5 ? S.metricWarn : S.metricBad

  return (
    <div>
      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <input
          value={deal.name}
          onChange={e => f('name')(e.target.value)}
          style={{ background: 'transparent', border: 'none', color: '#fff', fontSize: 20, fontWeight: 700, outline: 'none', flex: 1 }}
          placeholder="Deal Name"
        />
        {deal.status && <span style={S.tag('#4f8ef7')}>{deal.status}</span>}
        {deal.dealScore && <span style={{ ...S.tag('#48bb78'), ...scoreColor(deal.dealScore) }}>Score: {deal.dealScore}/10</span>}
      </div>

      {/* ── A. Property ── */}
      <div style={S.sectionCard}>
        <div style={S.sectionTitle}>A · Property Information</div>
        <div style={S.grid2}>
          <Field label="Street Address" value={deal.address} onChange={f('address')} />
          <Field label="City, State, Zip" value={deal.city} onChange={f('city')} />
        </div>
        <div style={{ ...S.grid3, marginTop: 8 }}>
          <SelectField label="Property Type" value={deal.propertyType} onChange={f('propertyType')} options={['Flex', 'Industrial', 'Office', 'Retail', 'Mixed']} />
          <Field label="Building Size (SF)" type="number" value={deal.buildingSize} onChange={f('buildingSize')} />
          <Field label="Land Area (Acres)" type="number" value={deal.landAcres} onChange={f('landAcres')} />
        </div>
        <div style={{ ...S.grid3, marginTop: 8 }}>
          <Field label="Year Built" type="number" value={deal.yearBuilt} onChange={f('yearBuilt')} />
          <Field label="Clear Height (ft)" value={deal.clearHeight} onChange={f('clearHeight')} />
          <Field label="Zoning" value={deal.zoning} onChange={f('zoning')} />
        </div>
        <div style={{ ...S.grid3, marginTop: 8 }}>
          <Field label="Dock Doors" type="number" value={deal.dockDoors} onChange={f('dockDoors')} />
          <Field label="Drive-In Doors" type="number" value={deal.driveInDoors} onChange={f('driveInDoors')} />
          <Field label="# of Tenants" type="number" value={deal.tenantCount} onChange={f('tenantCount')} />
        </div>
        <div style={{ ...S.grid3, marginTop: 8 }}>
          <Field label="Office Finish %" type="number" value={deal.officeFinishPct != null ? +(deal.officeFinishPct * 100).toFixed(1) : ''} onChange={v => f('officeFinishPct')(v != null ? v / 100 : null)} suffix="%" />
          <SelectField label="Sprinklered?" value={deal.sprinklered} onChange={f('sprinklered')} options={['Yes', 'No', 'Partial']} />
          <Field label="Power (Amps)" type="number" value={deal.power} onChange={f('power')} />
        </div>
      </div>

      {/* ── B. Acquisition ── */}
      <div style={S.sectionCard}>
        <div style={S.sectionTitle}>B · Acquisition &amp; Costs</div>
        <div style={S.grid2}>
          <Field label="Asking Price ($)" type="number" value={deal.askingPrice} onChange={f('askingPrice')} prefix="$" />
          <Field label="Purchase Price ($)" type="number" value={deal.purchasePrice} onChange={f('purchasePrice')} prefix="$" />
        </div>
        <div style={{ ...S.grid3, marginTop: 8 }}>
          <Field label="Earnest Money ($)" type="number" value={deal.earnestMoney} onChange={f('earnestMoney')} prefix="$" />
          <Field label="Closing Costs % (override)" type="number"
            value={deal.closingCostPct != null ? +(deal.closingCostPct * 100).toFixed(2) : ''}
            onChange={v => f('closingCostPct')(v != null ? v / 100 : null)}
            placeholder={`${(assumptions.closingCostPct * 100).toFixed(1)}% (global)`} suffix="%" />
          <Field label="CapEx Reserve ($/SF)" type="number" value={deal.capexPSF} onChange={f('capexPSF')} />
        </div>
        <div style={{ ...S.grid3, marginTop: 10, background: '#0f1117', padding: '8px 10px', borderRadius: 6 }}>
          <div><div style={S.fieldLabel}>Price / SF</div><div style={{ fontWeight: 600 }}>{fmt.psf(m.pricePSF)}</div></div>
          <div><div style={S.fieldLabel}>Closing Costs</div><div style={{ fontWeight: 600 }}>{fmt.currency(m.closingCosts)}</div></div>
          <div><div style={S.fieldLabel}>Total Acq. Cost</div><div style={{ fontWeight: 600 }}>{fmt.currency(m.totalAcqCost)}</div></div>
        </div>
      </div>

      {/* ── C. Income ── */}
      <div style={S.sectionCard}>
        <div style={S.sectionTitle}>C · Income Analysis</div>
        <div style={S.grid3}>
          <Field label="In-Place Rent ($/SF/yr)" type="number" value={deal.rentPSF} onChange={f('rentPSF')} prefix="$" />
          <Field label="Other Income ($/yr)" type="number" value={deal.otherIncome} onChange={f('otherIncome')} prefix="$" />
          <SelectField label="Lease Type" value={deal.leaseType} onChange={f('leaseType')} options={['NNN', 'Modified Gross', 'Gross', 'NN', 'Vacant']} />
        </div>
        <div style={{ ...S.grid3, marginTop: 8 }}>
          <Field label="Lease Expiration" value={deal.leaseExpiration} onChange={f('leaseExpiration')} placeholder="MM/YYYY or Varies" />
          <Field label="Remaining Term (yrs)" type="number" value={deal.remainingTerm} onChange={f('remainingTerm')} />
          <Field label="Rent Escalation % (override)" type="number"
            value={deal.escalation != null ? +(deal.escalation * 100).toFixed(2) : ''}
            onChange={v => f('escalation')(v != null ? v / 100 : null)}
            placeholder={`${(assumptions.escalation * 100).toFixed(1)}% (global)`} suffix="%" />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px 16px', marginTop: 10, background: '#0f1117', padding: '8px 10px', borderRadius: 6 }}>
          <div><div style={S.fieldLabel}>Gross Potential Rent</div><div style={{ fontWeight: 600 }}>{fmt.currency(m.gpr)}</div></div>
          <div><div style={S.fieldLabel}>Effective Gross Income</div><div style={{ fontWeight: 600 }}>{fmt.currency(m.egi)}</div></div>
          <div><div style={S.fieldLabel}>Vacancy/Credit Loss</div><div style={{ fontWeight: 600 }}>{fmt.currency(m.gpr - m.egi + (deal.otherIncome || 0))}</div></div>
        </div>
      </div>

      {/* ── D. Expenses ── */}
      <div style={S.sectionCard}>
        <div style={S.sectionTitle}>D · Operating Expenses (Annual)</div>
        <div style={{ color: '#718096', fontSize: 11, marginBottom: 10 }}>Vacancy, credit loss, and mgmt fee override global assumptions when set.</div>
        <div style={S.grid3}>
          <Field label="Vacancy % (override)" type="number"
            value={deal.vacancy != null ? +(deal.vacancy * 100).toFixed(2) : ''}
            onChange={v => f('vacancy')(v != null ? v / 100 : null)}
            placeholder={`${(assumptions.vacancy * 100).toFixed(0)}% (global)`} suffix="%" />
          <Field label="Credit Loss % (override)" type="number"
            value={deal.creditLoss != null ? +(deal.creditLoss * 100).toFixed(2) : ''}
            onChange={v => f('creditLoss')(v != null ? v / 100 : null)}
            placeholder={`${(assumptions.creditLoss * 100).toFixed(0)}% (global)`} suffix="%" />
          <Field label="Mgmt Fee % EGI (override)" type="number"
            value={deal.mgmtFee != null ? +(deal.mgmtFee * 100).toFixed(2) : ''}
            onChange={v => f('mgmtFee')(v != null ? v / 100 : null)}
            placeholder={`${(assumptions.mgmtFee * 100).toFixed(0)}% (global)`} suffix="%" />
        </div>
        <div style={{ ...S.grid3, marginTop: 8 }}>
          <Field label="Property Taxes ($/yr)" type="number" value={deal.propTax} onChange={f('propTax')} prefix="$" />
          <Field label="Insurance ($/yr)" type="number" value={deal.insurance} onChange={f('insurance')} prefix="$" />
          <Field label="Maintenance ($/yr)" type="number" value={deal.maintenance} onChange={f('maintenance')} prefix="$" />
        </div>
        <div style={{ ...S.grid3, marginTop: 8 }}>
          <Field label="Utilities ($/yr)" type="number" value={deal.utilities} onChange={f('utilities')} prefix="$" />
          <Field label="Landscaping/Snow ($/yr)" type="number" value={deal.landscaping} onChange={f('landscaping')} prefix="$" />
          <Field label="Reserves ($/yr)" type="number" value={deal.reserves} onChange={f('reserves')} prefix="$" />
        </div>
        <div style={{ ...S.grid2, marginTop: 8 }}>
          <Field label="Administrative ($/yr)" type="number" value={deal.adminExp} onChange={f('adminExp')} prefix="$" />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '8px 16px', marginTop: 10, background: '#0f1117', padding: '8px 10px', borderRadius: 6 }}>
          <div><div style={S.fieldLabel}>Mgmt Fee $</div><div style={{ fontWeight: 600 }}>{fmt.currency(m.mgmtFeeAmt)}</div></div>
          <div><div style={S.fieldLabel}>Total OpEx</div><div style={{ fontWeight: 600 }}>{fmt.currency(m.totalOpEx)}</div></div>
          <div><div style={S.fieldLabel}>Expense Ratio</div><div style={{ fontWeight: 600 }}>{fmt.pct(m.expenseRatio)}</div></div>
          <div><div style={S.fieldLabel}>NOI</div><div style={{ fontWeight: 600, color: '#48bb78' }}>{fmt.currency(m.noi)}</div></div>
        </div>
      </div>

      {/* ── E. Financing ── */}
      <div style={S.sectionCard}>
        <div style={S.sectionTitle}>E · Financing</div>
        <div style={{ color: '#718096', fontSize: 11, marginBottom: 10 }}>Override global assumptions per deal, or leave blank to use global defaults.</div>
        <div style={S.grid3}>
          <Field label="LTV % (override)" type="number"
            value={deal.ltv != null ? +(deal.ltv * 100).toFixed(1) : ''}
            onChange={v => f('ltv')(v != null ? v / 100 : null)}
            placeholder={`${(assumptions.ltv * 100).toFixed(0)}% (global)`} suffix="%" />
          <Field label="Interest Rate % (override)" type="number"
            value={deal.interestRate != null ? +(deal.interestRate * 100).toFixed(3) : ''}
            onChange={v => f('interestRate')(v != null ? v / 100 : null)}
            placeholder={`${(assumptions.interestRate * 100).toFixed(2)}% (global)`} suffix="%" />
          <Field label="Amortization (yrs)" type="number"
            value={deal.amortYears}
            onChange={f('amortYears')}
            placeholder={`${assumptions.amortYears} (global)`} />
        </div>
        <div style={{ ...S.grid3, marginTop: 8 }}>
          <Field label="Loan Term (yrs)" type="number"
            value={deal.loanTermYears}
            onChange={f('loanTermYears')}
            placeholder={`${assumptions.loanTermYears} (global)`} />
          <Field label="Hold Period (yrs)" type="number" value={deal.holdYears} onChange={f('holdYears')} />
          <Field label="Exit Cap Premium (override)" type="number"
            value={deal.exitCapPremium != null ? +(deal.exitCapPremium * 100).toFixed(3) : ''}
            onChange={v => f('exitCapPremium')(v != null ? v / 100 : null)}
            placeholder={`${(assumptions.exitCapPremium * 100).toFixed(2)}% (global)`} suffix="%" />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px 16px', marginTop: 10, background: '#0f1117', padding: '8px 10px', borderRadius: 6 }}>
          <div><div style={S.fieldLabel}>Loan Amount</div><div style={{ fontWeight: 600 }}>{fmt.currency(m.loanAmt)}</div></div>
          <div><div style={S.fieldLabel}>LTV</div><div style={{ fontWeight: 600 }}>{fmt.pct(m.ltv_actual)}</div></div>
          <div><div style={S.fieldLabel}>Equity Required</div><div style={{ fontWeight: 600 }}>{fmt.currency(m.equity)}</div></div>
          <div><div style={S.fieldLabel}>Annual Debt Service</div><div style={{ fontWeight: 600 }}>{fmt.currency(m.annualDS)}</div></div>
        </div>
      </div>

      {/* ── G. Assessment ── */}
      <div style={S.sectionCard}>
        <div style={S.sectionTitle}>G · Deal Assessment</div>
        <div style={S.grid3}>
          <Field label="Deal Score (1-10)" type="number" value={deal.dealScore} onChange={f('dealScore')} />
          <SelectField label="Status" value={deal.status} onChange={f('status')} options={['Active', 'Under Contract', 'Passed', 'Closed', 'Watch List']} />
        </div>
        <div style={{ marginTop: 8 }}>
          <div style={S.fieldLabel}>Broker / Notes</div>
          <textarea
            value={deal.brokerNotes || ''}
            onChange={e => f('brokerNotes')(e.target.value)}
            rows={3}
            placeholder="Broker info, deal notes, red flags..."
            style={{ width: '100%', background: '#1e2535', border: '1px solid #2d3748', color: '#e2e8f0', borderRadius: 4, padding: '6px 8px', fontSize: 13, resize: 'vertical', outline: 'none' }}
          />
        </div>
      </div>
    </div>
  )
}

function MetricsPanel({ deal, assumptions }) {
  const m = computeMetrics(deal, assumptions)
  const minCR = 0.055, minCOC = 0.07, minIRR_lev = 0.12, minIRR_unlev = 0.08, minEM = 1.5

  return (
    <div style={{ padding: 16 }}>
      <div style={{ ...S.sectionTitle }}>Return Metrics</div>

      <div style={{ background: '#0f1117', borderRadius: 8, padding: '10px 12px', marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: '#718096', marginBottom: 6 }}>INCOME</div>
        <MetricRow label="NOI" value={fmt.currency(m.noi)} good={m.noi > 0} />
        <MetricRow label="Cap Rate" value={fmt.pct(m.capRate)} good={m.capRate >= minCR} warn={m.capRate >= minCR * 0.9} />
        <MetricRow label="Cash-on-Cash" value={fmt.pct(m.coc)} good={m.coc >= minCOC} warn={m.coc >= minCOC * 0.8} />
        <MetricRow label="GRM" value={fmt.mult(m.grm)} />
        <MetricRow label="NOI / SF" value={fmt.psf(m.noiPSF)} />
        <MetricRow label="Break-even Occ." value={fmt.pct(m.breakEven)} good={m.breakEven < 0.65} warn={m.breakEven < 0.80} />
      </div>

      <div style={{ background: '#0f1117', borderRadius: 8, padding: '10px 12px', marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: '#718096', marginBottom: 6 }}>DEBT</div>
        <MetricRow label="DSCR" value={m.dscr ? m.dscr.toFixed(2) + 'x' : '—'} good={m.dscr >= 1.25} warn={m.dscr >= 1.0} />
        <MetricRow label="Debt Yield" value={fmt.pct(m.debtYield)} good={m.debtYield >= 0.08} warn={m.debtYield >= 0.065} />
        <MetricRow label="LTV" value={fmt.pct(m.ltv_actual)} good={m.ltv_actual <= 0.65} warn={m.ltv_actual <= 0.75} />
      </div>

      <div style={{ background: '#0f1117', borderRadius: 8, padding: '10px 12px', marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: '#718096', marginBottom: 6 }}>EXIT  ({deal.holdYears || 10}yr hold)</div>
        <MetricRow label="Entry Cap Rate" value={fmt.pct(m.capRate)} />
        <MetricRow label="Exit Cap Rate" value={fmt.pct(m.exitCapRate)} />
        <MetricRow label="Exit Value" value={fmt.currency(m.exitValue)} />
        <MetricRow label="Equity at Exit" value={fmt.currency(m.equityAtExit)} good={m.equityAtExit > m.equity} />
        <MetricRow label="Equity Multiple" value={fmt.mult(m.equityMult)} good={m.equityMult >= minEM} warn={m.equityMult >= 1.2} />
      </div>

      <div style={{ background: '#0f1117', borderRadius: 8, padding: '10px 12px', marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: '#718096', marginBottom: 6 }}>IRR</div>
        <MetricRow label="Unlevered IRR" value={fmt.pct(m.irrUnlev)} good={m.irrUnlev >= minIRR_unlev} warn={m.irrUnlev >= 0.06} />
        <MetricRow label="Levered IRR" value={fmt.pct(m.irrLev)} good={m.irrLev >= minIRR_lev} warn={m.irrLev >= 0.09} />
      </div>

      {/* Quick scorecard */}
      <div style={{ ...S.sectionTitle, marginTop: 8 }}>Scorecard</div>
      {[
        { label: 'Cap Rate', pass: m.capRate >= minCR, val: fmt.pct(m.capRate), target: fmt.pct(minCR) },
        { label: 'Cash-on-Cash', pass: m.coc >= minCOC, val: fmt.pct(m.coc), target: fmt.pct(minCOC) },
        { label: 'Unlevered IRR', pass: m.irrUnlev >= minIRR_unlev, val: fmt.pct(m.irrUnlev), target: fmt.pct(minIRR_unlev) },
        { label: 'Levered IRR', pass: m.irrLev >= minIRR_lev, val: fmt.pct(m.irrLev), target: fmt.pct(minIRR_lev) },
        { label: 'Equity Multiple', pass: m.equityMult >= minEM, val: fmt.mult(m.equityMult), target: `${minEM}x` },
        { label: 'DSCR ≥ 1.25x', pass: m.dscr >= 1.25, val: m.dscr ? m.dscr.toFixed(2) + 'x' : '—', target: '1.25x' },
      ].map(({ label, pass, val, target }) => (
        <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid #1a2133', alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: '#718096' }}>{label}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, color: '#4a5568' }}>&gt; {target}</span>
            <span style={{ ...S.tag(pass ? '#48bb78' : (val === '—' ? '#718096' : '#fc8181')), fontSize: 10 }}>{val}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

function ComparisonView({ deals, assumptions }) {
  const metrics = deals.map(d => ({ ...computeMetrics(d, assumptions), deal: d }))

  const cols = [
    { label: 'Deal', fn: m => m.deal.name, style: { fontWeight: 600 } },
    { label: 'Price', fn: m => fmt.currency(m.deal.purchasePrice) },
    { label: '$/SF', fn: m => fmt.psf(m.pricePSF) },
    { label: 'SF', fn: m => fmt.num(m.deal.buildingSize) },
    { label: 'NOI', fn: m => fmt.currency(m.noi) },
    { label: 'Cap Rate', fn: m => fmt.pct(m.capRate) },
    { label: 'CoC', fn: m => fmt.pct(m.coc) },
    { label: 'GRM', fn: m => fmt.mult(m.grm) },
    { label: 'DSCR', fn: m => m.dscr ? m.dscr.toFixed(2) + 'x' : '—' },
    { label: 'Eq. Mult.', fn: m => fmt.mult(m.equityMult) },
    { label: 'Unlev IRR', fn: m => fmt.pct(m.irrUnlev) },
    { label: 'Lev IRR', fn: m => fmt.pct(m.irrLev) },
    { label: 'Status', fn: m => m.deal.status || '—' },
  ]

  return (
    <div>
      <div style={{ ...S.sectionTitle, marginBottom: 16 }}>Deal Comparison</div>
      {deals.length === 0 ? (
        <div style={{ color: '#4a5568', padding: 20 }}>No deals to compare. Add a deal from the sidebar.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>
                {cols.map(c => (
                  <th key={c.label} style={{ textAlign: 'left', padding: '6px 10px', color: '#4f8ef7', fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', borderBottom: '1px solid #1e2535', whiteSpace: 'nowrap' }}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {metrics.map((m, i) => (
                <tr key={m.deal.id} style={{ background: i % 2 === 0 ? '#0f1117' : '#111827' }}>
                  {cols.map(c => (
                    <td key={c.label} style={{ padding: '7px 10px', borderBottom: '1px solid #1a2133', whiteSpace: 'nowrap', ...(c.style || {}) }}>
                      {c.fn(m)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── App ───────────────────────────────────────────────────────────────────
export default function App() {
  const [assumptions, setAssumptions] = useState(DEFAULT_ASSUMPTIONS)
  const [deals, setDeals] = useState(SAMPLE_DEALS)
  const [activeId, setActiveId] = useState(SAMPLE_DEALS[0]?.id ?? null)
  const [view, setView] = useState('deal') // 'deal' | 'compare'

  const activeDeal = deals.find(d => d.id === activeId)

  const updateDeal = useCallback((updated) => {
    setDeals(prev => prev.map(d => d.id === updated.id ? updated : d))
  }, [])

  const addDeal = () => {
    const d = newDeal()
    setDeals(prev => [...prev, d])
    setActiveId(d.id)
    setView('deal')
  }

  const deleteDeal = (id) => {
    setDeals(prev => {
      const next = prev.filter(d => d.id !== id)
      if (activeId === id) setActiveId(next[0]?.id ?? null)
      return next
    })
  }

  return (
    <div style={S.app}>
      {/* Header */}
      <div style={S.header}>
        <div style={S.logo}>J3 · INVESTMENT ANALYZER</div>
        <div style={{ display: 'flex', gap: 6, marginLeft: 20 }}>
          <button style={S.tab(view === 'deal')} onClick={() => setView('deal')}>Deal View</button>
          <button style={S.tab(view === 'compare')} onClick={() => setView('compare')}>Compare</button>
          <button style={S.tab(view === 'assumptions')} onClick={() => setView('assumptions')}>Assumptions</button>
        </div>
        <div style={{ marginLeft: 'auto', color: '#4a5568', fontSize: 11 }}>
          {deals.length} deal{deals.length !== 1 ? 's' : ''}
        </div>
      </div>

      {/* Body */}
      <div style={S.body}>
        {/* Sidebar */}
        <div style={S.sidebar}>
          <div style={{ color: '#4a5568', fontSize: 10, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 8 }}>Deals</div>
          {deals.map(d => {
            const m = computeMetrics(d, assumptions)
            return (
              <div key={d.id} style={{ position: 'relative' }}>
                <button style={S.dealBtn(d.id === activeId)} onClick={() => { setActiveId(d.id); setView('deal') }}>
                  <div style={{ fontWeight: 600, fontSize: 12 }}>{d.name || 'Unnamed'}</div>
                  <div style={{ fontSize: 10, color: '#4a5568', marginTop: 2 }}>
                    {d.city || '—'} · {d.buildingSize ? fmt.num(d.buildingSize) + ' SF' : '—'}
                  </div>
                  <div style={{ fontSize: 10, color: m.capRate >= 0.055 ? '#48bb78' : '#718096', marginTop: 2 }}>
                    {m.capRate ? fmt.pct(m.capRate) + ' cap' : '—'} · {m.irrLev ? fmt.pct(m.irrLev) + ' IRR' : '—'}
                  </div>
                </button>
                <button style={{ ...S.deleteBtn, position: 'absolute', top: 6, right: 6 }} onClick={() => deleteDeal(d.id)}>✕</button>
              </div>
            )
          })}
          <button style={S.addBtn} onClick={addDeal}>+ Add Deal</button>
        </div>

        {/* Main */}
        <div style={S.main}>
          {view === 'compare' && <ComparisonView deals={deals} assumptions={assumptions} />}
          {view === 'assumptions' && <AssumptionsPanel assumptions={assumptions} onChange={setAssumptions} />}
          {view === 'deal' && activeDeal && (
            <DealForm deal={activeDeal} assumptions={assumptions} onChange={updateDeal} />
          )}
          {view === 'deal' && !activeDeal && (
            <div style={{ color: '#4a5568', padding: 40, textAlign: 'center' }}>
              <div style={{ fontSize: 16, marginBottom: 8 }}>No deal selected</div>
              <button style={{ ...S.addBtn, width: 'auto', padding: '10px 20px' }} onClick={addDeal}>+ Add your first deal</button>
            </div>
          )}
        </div>

        {/* Metrics Panel */}
        <div style={S.panel}>
          {activeDeal && view === 'deal' ? (
            <MetricsPanel deal={activeDeal} assumptions={assumptions} />
          ) : (
            <div style={{ padding: 16, color: '#4a5568', fontSize: 12 }}>Select a deal to see metrics.</div>
          )}
        </div>
      </div>
    </div>
  )
}
