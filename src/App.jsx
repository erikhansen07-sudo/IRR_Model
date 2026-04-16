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
    name: 'Northgate Blvd', address: '4125-4131 Northgate Blvd', city: 'Sacramento, CA',
    propertyType: 'Flex', buildingSize: 37799, landAcres: 2.77, yearBuilt: 1983,
    clearHeight: "16'-20'", dockDoors: 0, driveInDoors: 2, officeFinishPct: 0.74,
    tenantCount: 1, zoning: 'MP - Industrial', sprinklered: 'Yes', power: 1200,
    askingPrice: null, purchasePrice: null,
    rentPSF: null, leaseType: 'NNN', holdYears: 10,
    status: 'Watch List', brokerNotes: 'No pricing yet. High office finish (74%) limits industrial flex appeal. 1983 vintage — budget for deferred maintenance.',
  }),
  newDeal({
    name: 'Beatty Drive', address: '9210 Beatty Drive', city: 'Sacramento, CA',
    propertyType: 'Industrial', buildingSize: 13993, landAcres: 1.02, yearBuilt: 2005,
    clearHeight: "18'-20'", dockDoors: 0, driveInDoors: 5, officeFinishPct: 0.30,
    tenantCount: 1, zoning: 'M-1', sprinklered: 'Yes', power: 400,
    askingPrice: 2400000, purchasePrice: 2400000,
    rentPSF: 10.67, leaseType: 'NNN', leaseExpiration: '12/2028', escalation: 0.03, remainingTerm: 5,
    holdYears: 10,
  }),
  newDeal({
    name: '27th St', address: '6201 27th St', city: 'Sacramento, CA',
    propertyType: 'Industrial', buildingSize: 23000, landAcres: 1.38, yearBuilt: 1966,
    clearHeight: "20'", dockDoors: 0, driveInDoors: 6, officeFinishPct: 0.30,
    tenantCount: 1, zoning: 'M-1S', sprinklered: 'No',
    askingPrice: 3600000, purchasePrice: 3600000,
    rentPSF: 7.80, leaseType: 'Vacant', escalation: null, remainingTerm: null,
    holdYears: 10,
    brokerNotes: 'Currently vacant. 1966 vintage, no sprinklers. Upside play if leased at market — but execution risk is high.',
  }),
  newDeal({
    name: 'Via El Centro', address: '390-398 Via El Centro', city: 'Oceanside, CA',
    propertyType: 'Industrial', buildingSize: 28313, yearBuilt: null,
    clearHeight: "16'", dockDoors: 0, driveInDoors: 8,
    tenantCount: 5, zoning: 'IL',
    askingPrice: 7500000, purchasePrice: 7250000,
    rentPSF: 16.51, leaseType: 'NNN', escalation: 0.03,
    holdYears: 10,
    brokerNotes: 'Negotiated $250K off ask. 5 tenants — diversified income but watch rollover concentration.',
  }),
  newDeal({
    name: 'W 52nd Ave', address: '1220 W 52nd Ave', city: 'Wheat Ridge, CO',
    propertyType: 'Industrial', buildingSize: 18000, landAcres: 1.62, yearBuilt: 1997,
    dockDoors: 0, driveInDoors: 0, tenantCount: 6, zoning: 'PID',
    askingPrice: 3300000, purchasePrice: 3300000,
    rentPSF: 15.04, leaseType: 'Modified Gross', escalation: 0.04, remainingTerm: null,
    mgmtFee: 0.05,
    propTax: 73531, insurance: 13388, maintenance: 9000,
    utilities: 4699, landscaping: 3970, reserves: 5000,
    holdYears: 10,
    brokerNotes: '6 tenants on MG leases — expenses are real and eat into NOI. Landlord pays utilities, insurance, taxes. Confirmed expenses from actual bills.',
  }),
  newDeal({
    name: 'Monarch Park Pl', address: '6268 Monarch Park Place', city: 'Niwot, CO',
    propertyType: 'Industrial', buildingSize: 37264, landAcres: 3.26, yearBuilt: 1992,
    clearHeight: null, dockDoors: 4, driveInDoors: 2, officeFinishPct: 0.30,
    tenantCount: 2, zoning: 'ED - Boulder County', sprinklered: 'Yes', power: 4000,
    askingPrice: 6746500, purchasePrice: 6746500,
    rentPSF: 19.01, leaseType: 'NNN', remainingTerm: 5,
    holdYears: 10,
    brokerNotes: 'Boulder County submarket. 4000A power is a strong feature. 2-tenant risk — confirm individual lease terms and rollover dates.',
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

// ─── Advisor Engine ────────────────────────────────────────────────────────

const GOALS = [
  {
    id: 'overall', label: 'Best Overall', icon: '⚡',
    desc: 'Weighted composite across return, income, safety, and efficiency',
  },
  { id: 'irr',          label: 'Highest IRR',             icon: '📈', desc: 'Maximize total return on equity over hold period' },
  { id: 'cap_rate',     label: 'Best Cap Rate',            icon: '🏢', desc: 'Maximum income yield on purchase price' },
  { id: 'coc',          label: 'Best Cash-on-Cash',        icon: '💵', desc: 'Highest current-year cash return on equity invested' },
  { id: 'equity_mult',  label: 'Best Equity Multiple',     icon: '✖', desc: 'Most total dollars returned per dollar invested' },
  { id: 'min_capital',  label: 'Lowest Capital Required',  icon: '💰', desc: 'Smallest equity check to get in the door' },
  { id: 'payback',      label: 'Fastest Payback',          icon: '⏱', desc: 'Fewest years to recoup your equity from cash flow' },
  { id: 'safest',       label: 'Safest Investment',        icon: '🛡', desc: 'Best debt coverage, lowest break-even, highest margin of safety' },
]

function normalize(values, higherIsBetter) {
  const valid = values.filter(v => v != null && isFinite(v))
  if (valid.length === 0) return values.map(() => 0)
  const min = Math.min(...valid), max = Math.max(...valid)
  return values.map(v => {
    if (v == null || !isFinite(v)) return 0
    if (max === min) return 50
    const n = (v - min) / (max - min) * 100
    return higherIsBetter ? n : 100 - n
  })
}

function rankDeals(dealMetrics, goalId) {
  if (dealMetrics.length === 0) return []

  const composite = (subMetrics) => {
    const scores = dealMetrics.map(() => 0)
    for (const sm of subMetrics) {
      const raws = dealMetrics.map(dm => sm.fn(dm.m))
      const normed = normalize(raws, sm.higher)
      normed.forEach((n, i) => { scores[i] += n * sm.w })
    }
    const maxS = Math.max(...scores) || 1
    return dealMetrics
      .map((dm, i) => ({ ...dm, score: scores[i] / maxS * 100 }))
      .sort((a, b) => b.score - a.score)
  }

  if (goalId === 'overall') {
    return composite([
      { fn: m => m.irrLev,      w: 0.25, higher: true },
      { fn: m => m.capRate,     w: 0.20, higher: true },
      { fn: m => m.equityMult,  w: 0.20, higher: true },
      { fn: m => m.coc,         w: 0.20, higher: true },
      { fn: m => m.dscr,        w: 0.15, higher: true },
    ])
  }

  if (goalId === 'safest') {
    return composite([
      { fn: m => m.dscr,                                         w: 0.40, higher: true  },
      { fn: m => m.breakEven != null ? 1 - m.breakEven : null,   w: 0.40, higher: true  },
      { fn: m => m.capRate,                                      w: 0.20, higher: true  },
    ])
  }

  const rawFn = {
    irr:         m => m.irrLev,
    cap_rate:    m => m.capRate,
    coc:         m => m.coc,
    equity_mult: m => m.equityMult,
    min_capital: m => m.equity,
    payback:     m => { const cf = m.noi - m.annualDS; return cf > 0 ? m.equity / cf : null },
  }[goalId]

  const higherBetter = !['min_capital', 'payback'].includes(goalId)
  const raws = dealMetrics.map(dm => rawFn(dm.m))
  const normed = normalize(raws, higherBetter)
  return dealMetrics
    .map((dm, i) => ({ ...dm, score: normed[i], rawValue: raws[i] }))
    .sort((a, b) => b.score - a.score)
}

function fmtGoalValue(goalId, m) {
  const cf = m.noi - m.annualDS
  const payback = cf > 0 ? m.equity / cf : null
  return {
    overall:      `${fmt.pct(m.irrLev)} IRR · ${fmt.pct(m.capRate)} cap`,
    irr:          fmt.pct(m.irrLev),
    cap_rate:     fmt.pct(m.capRate),
    coc:          fmt.pct(m.coc),
    equity_mult:  fmt.mult(m.equityMult),
    min_capital:  fmt.currency(m.equity),
    payback:      payback ? payback.toFixed(1) + ' yrs' : '—',
    safest:       m.dscr ? m.dscr.toFixed(2) + 'x DSCR · ' + fmt.pct(m.breakEven) + ' BE' : '—',
  }[goalId]
}

function generateNarrative(ranked, goalId, goal) {
  if (!ranked.length) return null
  const w = ranked[0], l = ranked[ranked.length - 1]
  const wm = w.m, wd = w.deal
  const runner = ranked[1]

  // ── Verdict ──
  const verdict = `${wd.name}.`

  // ── Primary reason (goal-specific) ──
  const cf = wm.noi - wm.annualDS
  const paybackYrs = cf > 0 ? (wm.equity / cf).toFixed(1) : null
  const margins = {
    irr:         runner ? `${((wm.irrLev - runner.m.irrLev) * 100).toFixed(1)}pp ahead of ${runner.deal.name}` : '',
    cap_rate:    runner ? `${((wm.capRate - runner.m.capRate) * 100).toFixed(1)}pp above the next deal` : '',
    coc:         runner ? `${((wm.coc - runner.m.coc) * 100).toFixed(1)}pp better cash-on-cash than ${runner.deal.name}` : '',
    equity_mult: runner ? `${(wm.equityMult - runner.m.equityMult).toFixed(2)}x more equity created than ${runner.deal.name}` : '',
    min_capital: runner ? fmt.currency(runner.m.equity - wm.equity) + ' cheaper equity check than the next deal' : '',
    payback:     paybackYrs ? `${paybackYrs}-year payback on your equity` : '',
    safest:      wm.dscr ? `${wm.dscr.toFixed(2)}x DSCR with a ${fmt.pct(wm.breakEven)} break-even — the widest safety margin in the pool` : '',
    overall:     runner ? `leads the field on a weighted composite of IRR, cap rate, equity multiple, cash-on-cash, and debt coverage` : '',
  }

  const primaryLines = {
    irr:         `At ${fmt.pct(wm.irrLev)} levered IRR, it's the strongest total return in your pipeline${runner ? ` — ${margins.irr}` : ''}.`,
    cap_rate:    `${fmt.pct(wm.capRate)} going-in cap rate is the best income yield in the pool${runner ? `, ${margins.cap_rate}` : ''}.`,
    coc:         `${fmt.pct(wm.coc)} cash-on-cash means this deal starts paying you back faster than anything else you're looking at${runner ? ` — ${margins.coc}` : ''}.`,
    equity_mult: `${fmt.mult(wm.equityMult)} equity multiple over a ${wd.holdYears || 10}-year hold — ${runner ? margins.equity_mult + '.' : 'best total wealth creation in the pool.'}`,
    min_capital: `Requires only ${fmt.currency(wm.equity)} in equity — ${runner ? margins.min_capital + '.' : 'the smallest check in your pipeline.'}`,
    payback:     paybackYrs ? `${margins.payback}. Capital efficiency wins here.` : `Fastest return of capital in the pool.`,
    safest:      `${margins.safest}. If protecting downside is the priority, this is the answer.`,
    overall:     `It ${margins.overall}. No single metric is the best, but the composite picture is the most convincing.`,
  }[goalId]

  // ── Supporting context ──
  const supportLines = []
  if (wm.noi > 0) supportLines.push(`NOI of ${fmt.currency(wm.noi)} on a ${fmt.currency(wd.purchasePrice)} acquisition — ${fmt.psf(wm.noiPSF)}/SF.`)
  if (wm.dscr && wm.dscr >= 1.0) supportLines.push(`Debt coverage at ${wm.dscr.toFixed(2)}x — lenders will be comfortable here.`)
  if (wd.remainingTerm && wd.leaseType) supportLines.push(`${wd.remainingTerm}-year remaining term on a ${wd.leaseType} lease de-risks near-term income.`)
  if (wm.breakEven && wm.breakEven < 0.80) supportLines.push(`Break-even occupancy of ${fmt.pct(wm.breakEven)} gives you meaningful cushion before you're underwater.`)

  // ── Watch outs for the winner ──
  const watch = []
  if (!wm.dscr || wm.dscr < 1.25) watch.push(`DSCR of ${wm.dscr ? wm.dscr.toFixed(2) + 'x' : '—'} is below 1.25x — tighter than lenders prefer. Either negotiate better terms or bring more equity.`)
  if (wm.capRate && wm.capRate < 0.055) watch.push(`${fmt.pct(wm.capRate)} cap rate is thin. You're underwriting future rent growth to make this work — if escalations don't materialize, returns compress quickly.`)
  if (wm.breakEven && wm.breakEven > 0.80) watch.push(`${fmt.pct(wm.breakEven)} break-even occupancy leaves limited buffer. One tenant departure changes the math materially.`)
  if (wm.irrLev && wm.irrLev < 0.10) watch.push(`Sub-10% levered IRR means you're mostly paying for stability, not growth. Make sure the income durability justifies the multiple.`)
  if (wd.yearBuilt && wd.yearBuilt < 1990) watch.push(`Built ${wd.yearBuilt} — budget aggressively for deferred maintenance and capex surprises.`)

  // ── Pass on ──
  const passOn = []
  for (const r of ranked.slice(1)) {
    const rm = r.m
    const flags = []
    if (rm.equityMult && rm.equityMult < 1.0) flags.push(`equity multiple below 1.0x means you're likely losing money in real terms`)
    if (rm.irrLev && rm.irrLev < 0.06) flags.push(`sub-6% levered IRR`)
    if (rm.dscr && rm.dscr < 1.0) flags.push(`DSCR below 1.0x — can't service debt from operations`)
    if (rm.capRate && rm.capRate < 0.045) flags.push(`cap rate under 4.5% — priced for perfection`)
    if (flags.length > 0) passOn.push({ name: r.deal.name, flags })
  }

  return { verdict, primaryLine: primaryLines, support: supportLines, watch, passOn }
}

function AdvisorView({ deals, assumptions }) {
  const [goalId, setGoalId] = useState('overall')
  const goal = GOALS.find(g => g.id === goalId)

  const activeDealMetrics = deals
    .filter(d => d.purchasePrice > 0 && d.buildingSize > 0)
    .map(d => ({ deal: d, m: computeMetrics(d, assumptions) }))

  const ranked = rankDeals(activeDealMetrics, goalId)
  const narrative = ranked.length >= 1 ? generateNarrative(ranked, goalId, goal) : null
  const winner = ranked[0]

  if (deals.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#4a5568' }}>
        Add deals to get an advisor recommendation.
      </div>
    )
  }

  if (activeDealMetrics.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#4a5568' }}>
        Fill in purchase price and building size on at least one deal.
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 900 }}>
      {/* Goal selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
        <div style={{ color: '#718096', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>OPTIMIZE FOR</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {GOALS.map(g => (
            <button
              key={g.id}
              onClick={() => setGoalId(g.id)}
              style={{
                padding: '6px 14px', borderRadius: 20, fontSize: 12, fontWeight: 500,
                background: goalId === g.id ? '#4f8ef7' : '#1e2535',
                color: goalId === g.id ? '#fff' : '#94a3b8',
                border: goalId === g.id ? '1px solid #4f8ef7' : '1px solid #2d3748',
              }}
            >
              {g.icon} {g.label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ color: '#4a5568', fontSize: 11, marginBottom: 24 }}>{goal.desc}</div>

      {narrative && winner && (
        <>
          {/* ── THE CALL ── */}
          <div style={{
            background: 'linear-gradient(135deg, #0d1f3c 0%, #0f2744 100%)',
            border: '1px solid #1e3a6e', borderRadius: 12, padding: 24, marginBottom: 20,
            position: 'relative', overflow: 'hidden'
          }}>
            <div style={{
              position: 'absolute', top: 0, left: 0, right: 0, height: 3,
              background: 'linear-gradient(90deg, #4f8ef7, #7c3aed)'
            }} />
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2, color: '#4f8ef7', marginBottom: 10, textTransform: 'uppercase' }}>
              The Call
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12 }}>
              <div style={{ fontSize: 28, fontWeight: 800, color: '#fff', letterSpacing: -0.5 }}>
                {narrative.verdict}
              </div>
              <div style={{ fontSize: 13, color: '#48bb78', fontWeight: 600 }}>
                Score: {winner.score.toFixed(0)}/100
              </div>
            </div>
            <div style={{ fontSize: 14, color: '#cbd5e0', lineHeight: 1.7, marginBottom: 14 }}>
              {narrative.primaryLine}
            </div>
            {narrative.support.length > 0 && (
              <div style={{ fontSize: 12, color: '#718096', lineHeight: 1.7 }}>
                {narrative.support.join(' ')}
              </div>
            )}
            {/* Key metrics strip */}
            <div style={{ display: 'flex', gap: 20, marginTop: 18, flexWrap: 'wrap' }}>
              {[
                { label: 'Levered IRR', val: fmt.pct(winner.m.irrLev) },
                { label: 'Cap Rate', val: fmt.pct(winner.m.capRate) },
                { label: 'Equity Multiple', val: fmt.mult(winner.m.equityMult) },
                { label: 'NOI', val: fmt.currency(winner.m.noi) },
                { label: 'Equity Required', val: fmt.currency(winner.m.equity) },
                { label: 'DSCR', val: winner.m.dscr ? winner.m.dscr.toFixed(2) + 'x' : '—' },
              ].map(({ label, val }) => (
                <div key={label} style={{ borderLeft: '2px solid #1e3a6e', paddingLeft: 12 }}>
                  <div style={{ fontSize: 10, color: '#4a5568', marginBottom: 2 }}>{label}</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0' }}>{val}</div>
                </div>
              ))}
            </div>
          </div>

          {/* ── WATCH OUT ── */}
          {narrative.watch.length > 0 && (
            <div style={{ background: '#1a1200', border: '1px solid #3d2e00', borderRadius: 10, padding: 16, marginBottom: 20 }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2, color: '#ecc94b', marginBottom: 10, textTransform: 'uppercase' }}>
                ⚠ Watch Out
              </div>
              {narrative.watch.map((w, i) => (
                <div key={i} style={{ fontSize: 12, color: '#d4a017', lineHeight: 1.6, marginBottom: i < narrative.watch.length - 1 ? 6 : 0 }}>
                  · {w}
                </div>
              ))}
            </div>
          )}

          {/* ── PASS ON ── */}
          {narrative.passOn.length > 0 && (
            <div style={{ background: '#1a0d0d', border: '1px solid #3d1515', borderRadius: 10, padding: 16, marginBottom: 20 }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 2, color: '#fc8181', marginBottom: 10, textTransform: 'uppercase' }}>
                🚫 Red Flags
              </div>
              {narrative.passOn.map(({ name, flags }, i) => (
                <div key={i} style={{ fontSize: 12, color: '#fc8181', lineHeight: 1.6, marginBottom: 4 }}>
                  <span style={{ fontWeight: 600 }}>{name}:</span> {flags.join('; ')}.
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── RANKED TABLE ── */}
      <div style={{ ...S.sectionCard, marginBottom: 0 }}>
        <div style={S.sectionTitle}>All Deals Ranked</div>
        {ranked.map((r, i) => {
          const isWinner = i === 0
          const barColor = isWinner ? '#4f8ef7' : i === 1 ? '#7c3aed' : '#2d3748'
          return (
            <div key={r.deal.id} style={{
              display: 'flex', alignItems: 'center', gap: 14, padding: '10px 0',
              borderBottom: '1px solid #1a2133', opacity: r.score === 0 ? 0.4 : 1
            }}>
              <div style={{ width: 24, fontWeight: 700, color: isWinner ? '#4f8ef7' : '#4a5568', textAlign: 'center', fontSize: 14 }}>
                {isWinner ? '🥇' : `#${i + 1}`}
              </div>
              <div style={{ width: 140, flexShrink: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: isWinner ? '#fff' : '#94a3b8' }}>{r.deal.name}</div>
                <div style={{ fontSize: 10, color: '#4a5568' }}>{r.deal.city || '—'}</div>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1, background: '#1e2535', borderRadius: 4, height: 8, overflow: 'hidden' }}>
                    <div style={{ width: `${r.score}%`, background: barColor, height: '100%', borderRadius: 4, transition: 'width 0.3s' }} />
                  </div>
                  <div style={{ width: 36, textAlign: 'right', fontSize: 12, fontWeight: 700, color: isWinner ? '#4f8ef7' : '#718096' }}>
                    {r.score.toFixed(0)}
                  </div>
                </div>
              </div>
              <div style={{ width: 160, textAlign: 'right', fontSize: 12, color: '#e2e8f0', fontWeight: 500 }}>
                {fmtGoalValue(goalId, r.m)}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Agent Intelligence ────────────────────────────────────────────────────

function findMentionedDeals(text, deals) {
  const t = text.toLowerCase()
  return deals.filter(d => {
    const name = d.name.toLowerCase()
    const street = (d.address || '').toLowerCase().split(' ').slice(1, 3).join(' ')
    return t.includes(name) || (street.length > 3 && t.includes(street))
  })
}

function detectGoal(text) {
  const t = text.toLowerCase()
  if (t.match(/irr|return|yield/)) return 'irr'
  if (t.match(/cap rate|capitalization/)) return 'cap_rate'
  if (t.match(/cash.on.cash|cash return|coc/)) return 'coc'
  if (t.match(/equity multiple|multiple|em\b/)) return 'equity_mult'
  if (t.match(/least capital|lowest capital|cheapest|smallest check|minimum equity/)) return 'min_capital'
  if (t.match(/payback|recoup|break.?even|fastest/)) return 'payback'
  if (t.match(/safe|risk|conservative|protect|downside|dscr/)) return 'safest'
  if (t.match(/overall|best deal|recommend|buy|which one/)) return 'overall'
  return null
}

function detectIntent(text) {
  const t = text.toLowerCase()
  if (t.match(/why.*(#?1|number one|top|first|win|best|ranked)/)) return 'explain_ranking'
  if (t.match(/compare|vs\.?|versus|difference between|better|between/)) return 'compare'
  if (t.match(/risk|red flag|concern|worry|watch out|downside|problem/)) return 'risks'
  if (t.match(/what is|explain|define|what does|how does|tell me about (irr|cap|noi|dscr|grm|equity)/)) return 'define'
  if (t.match(/what should i (buy|do|pick|choose)|recommend|advice|best deal|which one/)) return 'recommend'
  if (t.match(/rank|sort|order|list all|show all/)) return 'rank_all'
  if (t.match(/best.*for|optimize for|goal/)) return 'goal_based'
  if (t.match(/more|deeper|detail|explain|tell me (more|about)/)) return 'deep_dive'
  return 'deep_dive'
}

function agentResponse(input, deals, assumptions, history) {
  const allM = deals.map(d => ({ deal: d, m: computeMetrics(d, assumptions) }))
    .filter(dm => dm.deal.purchasePrice > 0 && dm.deal.buildingSize > 0)

  const mentioned = findMentionedDeals(input, deals)
  const intent = detectIntent(input)
  const goalId = detectGoal(input)
  const t = input.toLowerCase()

  // ── Define a term ──
  if (intent === 'define') {
    const defs = {
      irr: `**IRR (Internal Rate of Return)** is the annualized return that makes the NPV of all cash flows equal to zero. Levered IRR accounts for debt — it's your return on equity after paying the bank. Unlevered IRR measures the asset itself regardless of financing. Rule of thumb: levered IRR below 10% is thin; 12-15%+ is solid for industrial.`,
      'cap rate': `**Cap Rate** = NOI ÷ Purchase Price. It's the income yield if you paid all cash. A 6% cap means you earn $6 for every $100 invested before debt service. Higher cap = more income relative to price, but often also more risk or older vintage. Current industrial market: 5.5–7% is typical.`,
      noi: `**NOI (Net Operating Income)** = Effective Gross Income minus Operating Expenses. It's what the property earns before debt service, taxes, and depreciation. It's the number that drives cap rate, DSCR, and exit value.`,
      dscr: `**DSCR (Debt Service Coverage Ratio)** = NOI ÷ Annual Debt Service. A 1.25x DSCR means for every $1.25 of NOI, you owe the bank $1.00. Lenders typically require ≥1.20–1.25x. Below 1.0x means the property can't pay its own debt.`,
      grm: `**GRM (Gross Rent Multiplier)** = Price ÷ Gross Potential Rent. Quick and dirty valuation sanity check — doesn't account for expenses. Lower GRM = more income relative to price.`,
      'equity multiple': `**Equity Multiple** = Total equity returned ÷ Equity invested. A 1.5x means you doubled your money by 50%. Below 1.0x means you lost money in nominal terms. Target ≥ 1.5x over a 10-year hold.`,
    }
    const match = Object.keys(defs).find(k => t.includes(k))
    return match ? defs[match] : `Ask me to define cap rate, IRR, NOI, DSCR, GRM, or equity multiple and I'll break it down.`
  }

  // ── No deals with pricing ──
  if (allM.length === 0) return `None of your deals have purchase price and building size filled in yet. Add that data and I can give you real analysis.`

  // ── Full recommendation ──
  if (intent === 'recommend' && mentioned.length === 0) {
    const ranked = rankDeals(allM, 'overall')
    const w = ranked[0], ru = ranked[1]
    const wm = w.m
    const lines = [
      `**Buy ${w.deal.name}.** Here's the full case:`,
      ``,
      `It leads the pool on a weighted composite — ${fmt.pct(wm.irrLev)} levered IRR, ${fmt.pct(wm.capRate)} cap rate, ${fmt.mult(wm.equityMult)} equity multiple over a ${w.deal.holdYears || 10}-year hold. ${ru ? `That's meaningfully ahead of ${ru.deal.name} on an overall basis.` : ''}`,
      ``,
      `NOI of ${fmt.currency(wm.noi)} on a ${fmt.currency(w.deal.purchasePrice)} acquisition (${fmt.psf(wm.pricePSF)}/SF). ${wm.dscr ? `DSCR of ${wm.dscr.toFixed(2)}x is lender-friendly.` : ''}`,
    ]
    const risks = []
    if (wm.capRate < 0.055) risks.push(`cap rate is below 5.5% — you're relying on rent growth`)
    if (wm.dscr && wm.dscr < 1.25) risks.push(`DSCR is tighter than 1.25x`)
    if (w.deal.yearBuilt && w.deal.yearBuilt < 1990) risks.push(`${w.deal.yearBuilt} vintage — budget for capex`)
    if (risks.length > 0) lines.push(``, `**Watch:** ${risks.join('; ')}.`)
    return lines.join('\n')
  }

  // ── Goal-based ranking ──
  if ((intent === 'goal_based' || goalId) && mentioned.length === 0) {
    const gid = goalId || 'overall'
    const ranked = rankDeals(allM, gid)
    const goal = GOALS.find(g => g.id === gid)
    const w = ranked[0], ru = ranked[1]
    const lines = [
      `**For "${goal?.label}" — ${w.deal.name} wins.**`,
      ``,
      fmtGoalValue(gid, w.m) + ` — ${ru ? `vs. ${fmtGoalValue(gid, ru.m)} for ${ru.deal.name}` : 'best in the pool'}.`,
      ``,
      `Full ranking:`,
      ...ranked.map((r, i) => `${i === 0 ? '🥇' : `${i + 1}.`} **${r.deal.name}** — ${fmtGoalValue(gid, r.m)} (score: ${r.score.toFixed(0)}/100)`),
    ]
    return lines.join('\n')
  }

  // ── Rank all ──
  if (intent === 'rank_all') {
    const gid = goalId || 'overall'
    const ranked = rankDeals(allM, gid)
    const goal = GOALS.find(g => g.id === gid)
    const lines = [
      `**Ranked by ${goal?.label || 'Overall'}:**`,
      '',
      ...ranked.map((r, i) => {
        const m = r.m
        return `${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`} **${r.deal.name}** — IRR ${fmt.pct(m.irrLev)} · Cap ${fmt.pct(m.capRate)} · EM ${fmt.mult(m.equityMult)} · Score ${r.score.toFixed(0)}/100`
      }),
    ]
    return lines.join('\n')
  }

  // ── Compare two deals ──
  if (intent === 'compare' && mentioned.length >= 2) {
    const a = allM.find(dm => dm.deal.id === mentioned[0].id)
    const b = allM.find(dm => dm.deal.id === mentioned[1].id)
    if (!a || !b) return `I couldn't find metrics for both deals. Make sure they have pricing filled in.`
    const am = a.m, bm = b.m
    const wins = { [a.deal.name]: 0, [b.deal.name]: 0 }
    const rows = [
      { label: 'Price', aVal: fmt.currency(a.deal.purchasePrice), bVal: fmt.currency(b.deal.purchasePrice), winner: a.deal.purchasePrice < b.deal.purchasePrice ? a.deal.name : b.deal.name },
      { label: 'Cap Rate', aVal: fmt.pct(am.capRate), bVal: fmt.pct(bm.capRate), winner: (am.capRate || 0) > (bm.capRate || 0) ? a.deal.name : b.deal.name },
      { label: 'Levered IRR', aVal: fmt.pct(am.irrLev), bVal: fmt.pct(bm.irrLev), winner: (am.irrLev || 0) > (bm.irrLev || 0) ? a.deal.name : b.deal.name },
      { label: 'NOI', aVal: fmt.currency(am.noi), bVal: fmt.currency(bm.noi), winner: (am.noi || 0) > (bm.noi || 0) ? a.deal.name : b.deal.name },
      { label: 'Equity Multiple', aVal: fmt.mult(am.equityMult), bVal: fmt.mult(bm.equityMult), winner: (am.equityMult || 0) > (bm.equityMult || 0) ? a.deal.name : b.deal.name },
      { label: 'DSCR', aVal: am.dscr ? am.dscr.toFixed(2) + 'x' : '—', bVal: bm.dscr ? bm.dscr.toFixed(2) + 'x' : '—', winner: (am.dscr || 0) > (bm.dscr || 0) ? a.deal.name : b.deal.name },
      { label: 'Equity Required', aVal: fmt.currency(am.equity), bVal: fmt.currency(bm.equity), winner: (am.equity || 0) < (bm.equity || 0) ? a.deal.name : b.deal.name },
      { label: 'Break-even Occ.', aVal: fmt.pct(am.breakEven), bVal: fmt.pct(bm.breakEven), winner: (am.breakEven || 1) < (bm.breakEven || 1) ? a.deal.name : b.deal.name },
    ]
    rows.forEach(r => { if (r.winner) wins[r.winner] = (wins[r.winner] || 0) + 1 })
    const overallWinner = wins[a.deal.name] >= wins[b.deal.name] ? a.deal.name : b.deal.name
    const lines = [
      `**${a.deal.name} vs. ${b.deal.name}**`,
      '',
      ...rows.map(r => `**${r.label}:** ${a.deal.name} ${r.aVal} · ${b.deal.name} ${r.bVal}${r.winner ? ` → ${r.winner} wins` : ''}`),
      '',
      `**Bottom line:** ${overallWinner} wins ${wins[overallWinner]} of ${rows.length} categories. ${overallWinner === a.deal.name ? a.deal.name : b.deal.name} is the stronger deal on balance.`,
    ]
    return lines.join('\n')
  }

  // ── Explain ranking ──
  if (intent === 'explain_ranking') {
    const gid = goalId || 'overall'
    const ranked = rankDeals(allM, gid)
    const w = ranked[0], ru = ranked[1]
    const wm = w.m
    const cf = wm.noi - wm.annualDS
    const payback = cf > 0 ? (wm.equity / cf).toFixed(1) : null
    const lines = [
      `**Why ${w.deal.name} is #1 (${GOALS.find(g => g.id === gid)?.label || 'Overall'})**`,
      ``,
      `It leads because it scores highest on a weighted combination of the key return metrics:`,
      ``,
      `· **Levered IRR:** ${fmt.pct(wm.irrLev)}${ru ? ` vs. ${fmt.pct(ru.m.irrLev)} for ${ru.deal.name}` : ''}`,
      `· **Cap Rate:** ${fmt.pct(wm.capRate)} — ${wm.capRate >= 0.06 ? 'above the 6% threshold, solid income yield' : 'slightly thin but competitive'}`,
      `· **Equity Multiple:** ${fmt.mult(wm.equityMult)} over ${w.deal.holdYears || 10} years`,
      `· **NOI:** ${fmt.currency(wm.noi)} (${fmt.psf(wm.noiPSF)}/SF)`,
      `· **DSCR:** ${wm.dscr ? wm.dscr.toFixed(2) + 'x' : '—'}`,
      payback ? `· **Payback:** ~${payback} years to recoup equity from cash flow` : '',
      ``,
      `The gap matters too — it isn't just barely winning. Its composite score is ${w.score.toFixed(0)}/100 vs. ${ru ? ru.score.toFixed(0) + '/100 for ' + ru.deal.name : 'the rest of the field'}.`,
    ].filter(Boolean)

    const risks = []
    if (wm.capRate < 0.055) risks.push(`thin cap rate (${fmt.pct(wm.capRate)}) — you're betting on rent growth`)
    if (wm.dscr && wm.dscr < 1.25) risks.push(`DSCR of ${wm.dscr.toFixed(2)}x is below lender comfort`)
    if (w.deal.yearBuilt && w.deal.yearBuilt < 1990) risks.push(`${w.deal.yearBuilt} vintage — deferred maintenance risk`)
    if (w.deal.leaseType === 'Vacant') risks.push(`currently vacant — you're underwriting lease-up`)
    if (risks.length > 0) lines.push('', `**But watch:** ${risks.join('; ')}.`)
    return lines.join('\n')
  }

  // ── Risks for a specific deal ──
  if (intent === 'risks' && mentioned.length > 0) {
    const dm = allM.find(x => x.deal.id === mentioned[0].id)
    if (!dm) return `I don't have metrics for ${mentioned[0].name} — check that pricing is filled in.`
    const { deal: d, m } = dm
    const flags = []
    if (!d.purchasePrice) flags.push(`No purchase price — can't underwrite returns`)
    if (m.capRate && m.capRate < 0.05) flags.push(`Cap rate of ${fmt.pct(m.capRate)} is thin — priced for near-perfection on rent growth`)
    if (m.irrLev && m.irrLev < 0.08) flags.push(`Levered IRR of ${fmt.pct(m.irrLev)} is below a healthy 8% threshold`)
    if (m.equityMult && m.equityMult < 1.2) flags.push(`Equity multiple of ${fmt.mult(m.equityMult)} is dangerously close to losing money in real terms`)
    if (m.dscr && m.dscr < 1.25) flags.push(`DSCR of ${m.dscr.toFixed(2)}x is tight — lenders will push back`)
    if (m.dscr && m.dscr < 1.0) flags.push(`DSCR below 1.0x — the property can't service its own debt from operations`)
    if (m.breakEven && m.breakEven > 0.85) flags.push(`${fmt.pct(m.breakEven)} break-even occupancy leaves almost no cushion`)
    if (d.yearBuilt && d.yearBuilt < 1985) flags.push(`Built ${d.yearBuilt} — older vintage means environmental risk, lower ceiling heights, and potential capex surprises`)
    if (d.leaseType === 'Vacant') flags.push(`Currently vacant — you're buying on a pro forma, not in-place income`)
    if (d.leaseType === 'Modified Gross') flags.push(`MG lease — landlord absorbs expense risk. Validate actual expense history`)
    if (d.tenantCount === 1) flags.push(`Single tenant — 100% vacancy risk on lease expiration`)
    if (!d.sprinklered || d.sprinklered === 'No') flags.push(`Not sprinklered — limits tenant pool and may affect insurance`)

    if (flags.length === 0) return `**${d.name} looks reasonably clean.** No major red flags based on the data entered. Biggest unknown is whatever's missing — double-check operating expense details and lease terms.`

    return [`**Red flags for ${d.name}:**`, '', ...flags.map(f => `⚠ ${f}`)].join('\n')
  }

  // ── Deep dive on a specific deal ──
  if (mentioned.length > 0) {
    const dm = allM.find(x => x.deal.id === mentioned[0].id)
    if (!dm) {
      const d = mentioned[0]
      return `**${d.name}** — ${d.address}, ${d.city}. No financial data yet (missing purchase price or SF). Fill those in and I can give you the full picture.`
    }
    const { deal: d, m } = dm
    const ranked = rankDeals(allM, 'overall')
    const rank = ranked.findIndex(r => r.deal.id === d.id) + 1
    const cf = m.noi - m.annualDS
    const payback = cf > 0 ? (m.equity / cf).toFixed(1) : null

    const lines = [
      `**${d.name}** — ${d.address}, ${d.city}`,
      `${d.buildingSize?.toLocaleString()} SF · ${d.propertyType} · Built ${d.yearBuilt || 'N/A'} · ${d.leaseType || '—'} lease`,
      ``,
      `**Returns**`,
      `· Cap Rate: ${fmt.pct(m.capRate)}`,
      `· Levered IRR: ${fmt.pct(m.irrLev)}`,
      `· Unlevered IRR: ${fmt.pct(m.irrUnlev)}`,
      `· Cash-on-Cash: ${fmt.pct(m.coc)}`,
      `· Equity Multiple: ${fmt.mult(m.equityMult)} over ${d.holdYears || 10} years`,
      payback ? `· Payback Period: ~${payback} years` : '',
      ``,
      `**Income & Debt**`,
      `· NOI: ${fmt.currency(m.noi)} (${fmt.psf(m.noiPSF)}/SF)`,
      `· DSCR: ${m.dscr ? m.dscr.toFixed(2) + 'x' : '—'}`,
      `· Break-even Occupancy: ${fmt.pct(m.breakEven)}`,
      ``,
      `**Capital Stack**`,
      `· Purchase Price: ${fmt.currency(d.purchasePrice)} (${fmt.psf(m.pricePSF)}/SF)`,
      `· Equity Required: ${fmt.currency(m.equity)}`,
      `· Loan Amount: ${fmt.currency(m.loanAmt)} at ${fmt.pct(m.ltv_actual)} LTV`,
      `· Exit Value (${d.holdYears || 10}yr): ${fmt.currency(m.exitValue)}`,
      ``,
      `**Overall rank in pool: #${rank} of ${allM.length}**`,
    ].filter(Boolean)

    if (d.brokerNotes) lines.push('', `**Notes:** ${d.brokerNotes}`)
    return lines.join('\n')
  }

  // ── Fallback ──
  const suggestions = [
    `Try: "Why is ${allM[0]?.deal.name} ranked #1?"`,
    `Or: "Compare ${allM[0]?.deal.name} and ${allM[1]?.deal.name}"`,
    `Or: "What are the risks with ${allM[allM.length - 1]?.deal.name}?"`,
    `Or: "Which deal is best for lowest capital?"`,
    `Or: "What is IRR?"`,
  ]
  return `I can help with deal analysis, comparisons, risk flags, ranking explanations, and metric definitions.\n\n${suggestions.filter(Boolean).join('\n')}`
}

function AgentView({ deals, assumptions }) {
  const [messages, setMessages] = useState([
    {
      role: 'agent',
      text: `Hey — I'm your J3 deal advisor. I have full context on all ${deals.length} properties in your pipeline.\n\nAsk me anything:\n· "Why is Monarch Park Place #1 overall?"\n· "Compare Beatty Drive and Via El Centro"\n· "What are the risks with 27th St?"\n· "Which deal needs the least capital?"\n· "What should I buy?"`
    }
  ])
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const bottomRef = useState(null)
  const endRef = { current: null }

  const send = () => {
    const q = input.trim()
    if (!q) return
    const userMsg = { role: 'user', text: q }
    const newHistory = [...messages, userMsg]
    setMessages(newHistory)
    setInput('')
    setThinking(true)
    setTimeout(() => {
      const response = agentResponse(q, deals, assumptions, newHistory)
      setMessages(prev => [...prev, { role: 'agent', text: response }])
      setThinking(false)
    }, 400)
  }

  const CHIPS = [
    "What should I buy?",
    "Rank all deals",
    "Best cap rate?",
    "Why is Via El Centro #1?",
    "Risks on 27th St",
    "Compare Beatty Drive and Monarch Park",
    "Which needs least capital?",
    "What is IRR?",
  ]

  function MsgText({ text }) {
    const parts = text.split('\n')
    return (
      <div style={{ lineHeight: 1.7, fontSize: 13 }}>
        {parts.map((p, i) => {
          if (!p) return <br key={i} />
          const rendered = p.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
          return <div key={i} dangerouslySetInnerHTML={{ __html: rendered }} />
        })}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', maxWidth: 820 }}>
      {/* Suggestion chips */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 0 14px 0', flexShrink: 0 }}>
        {CHIPS.map(c => (
          <button key={c} onClick={() => { setInput(c); setTimeout(() => document.getElementById('agent-input')?.focus(), 50) }}
            style={{ padding: '4px 12px', borderRadius: 20, fontSize: 11, background: '#1e2535', color: '#94a3b8', border: '1px solid #2d3748', cursor: 'pointer' }}>
            {c}
          </button>
        ))}
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: 16 }}>
        {messages.map((msg, i) => (
          <div key={i} style={{ display: 'flex', gap: 10, justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start' }}>
            {msg.role === 'agent' && (
              <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'linear-gradient(135deg,#4f8ef7,#7c3aed)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0, marginTop: 2 }}>J</div>
            )}
            <div style={{
              maxWidth: '82%',
              background: msg.role === 'user' ? '#1e3a6e' : '#151b2e',
              border: msg.role === 'user' ? '1px solid #2d5cb8' : '1px solid #1e2535',
              borderRadius: msg.role === 'user' ? '12px 12px 4px 12px' : '4px 12px 12px 12px',
              padding: '10px 14px',
              color: '#e2e8f0',
            }}>
              <MsgText text={msg.text} />
            </div>
          </div>
        ))}
        {thinking && (
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'linear-gradient(135deg,#4f8ef7,#7c3aed)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>J</div>
            <div style={{ background: '#151b2e', border: '1px solid #1e2535', borderRadius: '4px 12px 12px 12px', padding: '12px 16px' }}>
              <div style={{ display: 'flex', gap: 4 }}>
                {[0,1,2].map(i => (
                  <div key={i} style={{ width: 6, height: 6, borderRadius: '50%', background: '#4f8ef7', animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite` }} />
                ))}
              </div>
            </div>
          </div>
        )}
        <div ref={r => { if (r) r.scrollIntoView({ behavior: 'smooth' }) }} />
      </div>

      {/* Input */}
      <div style={{ display: 'flex', gap: 8, paddingTop: 12, borderTop: '1px solid #1e2535', flexShrink: 0 }}>
        <input
          id="agent-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          placeholder="Ask anything about your deals..."
          style={{ flex: 1, padding: '10px 14px', background: '#1e2535', border: '1px solid #2d3748', borderRadius: 8, color: '#e2e8f0', fontSize: 13, outline: 'none' }}
        />
        <button onClick={send} style={{ padding: '10px 18px', background: '#4f8ef7', color: '#fff', borderRadius: 8, fontWeight: 600, fontSize: 13 }}>
          Send
        </button>
      </div>
      <style>{`@keyframes pulse { 0%,100%{opacity:.3;transform:scale(.8)} 50%{opacity:1;transform:scale(1)} }`}</style>
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
  const [view, setView] = useState('deal') // 'deal' | 'advisor' | 'compare' | 'assumptions'

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
          <button style={{
            ...S.tab(view === 'advisor'),
            ...(view !== 'advisor' ? { background: '#1a0d3d', color: '#a78bfa', border: '1px solid #4c1d95' } : { background: '#7c3aed', border: '1px solid #7c3aed' })
          }} onClick={() => setView('advisor')}>⚡ Advisor</button>
          <button style={{
            ...S.tab(view === 'agent'),
            ...(view !== 'agent' ? { background: '#0d1f1a', color: '#68d391', border: '1px solid #1a4731' } : { background: '#276749', border: '1px solid #276749' })
          }} onClick={() => setView('agent')}>💬 Agent</button>
          <button style={S.tab(view === 'assumptions')} onClick={() => setView('assumptions')}>Assumptions</button>
        </div>
        <div style={{ marginLeft: 'auto', color: '#4a5568', fontSize: 11 }}>
          {deals.length} deal{deals.length !== 1 ? 's' : ''}
        </div>
      </div>

      {/* Body */}
      <div style={{ ...S.body, gridTemplateColumns: view === 'deal' ? '220px 1fr 280px' : '220px 1fr' }}>
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
          {view === 'advisor' && <AdvisorView deals={deals} assumptions={assumptions} />}
          {view === 'agent' && <AgentView deals={deals} assumptions={assumptions} />}
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

        {/* Metrics Panel — only on deal view */}
        {view === 'deal' && (
          <div style={S.panel}>
            {activeDeal
              ? <MetricsPanel deal={activeDeal} assumptions={assumptions} />
              : <div style={{ padding: 16, color: '#4a5568', fontSize: 12 }}>Select a deal to see metrics.</div>
            }
          </div>
        )}
      </div>
    </div>
  )
}
