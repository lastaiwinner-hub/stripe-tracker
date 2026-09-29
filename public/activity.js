'use strict';

(() => {
  const amount = (n, currency = 'usd') => {
    if (n == null) return 'Unavailable';
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
    return new Intl.NumberFormat('en', { style: 'currency', currency }).format(n / 10 ** digits);
  };
  const date = n => n ? new Date(n * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not scheduled';
  const ref = value => typeof value === 'object' ? value?.id : value;
  const text = value => esc(String(value ?? '—'));
  const rows = (items, headings, cells) => `<div class="activity-scroll"><table class="activity-table"><thead><tr>${headings.map(h => `<th>${text(h)}</th>`).join('')}</tr></thead><tbody>${items.length ? items.map(item => `<tr>${cells(item).map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${headings.length}" class="activity-empty">No records returned by Stripe.</td></tr>`}</tbody></table></div>`;

  document.addEventListener('click', async event => {
    const launch = event.target.closest('[data-activity]');
    if (!launch) return;
    const id = Number(launch.dataset.activity);
    const account = state.accounts.find(a => a.id === id);
    if (!account) return;
    const previousFocus = document.activeElement;
    const back = document.createElement('div');
    back.className = 'modal-back activity-back';
    back.innerHTML = `<section class="activity-drawer" role="dialog" aria-modal="true" aria-labelledby="activity-title" tabindex="-1"><div class="activity-head"><div><span class="eyebrow">ACCOUNT ACTIVITY</span><h2 id="activity-title">${text(account.label)}</h2><p>${text(account.stripe_id)}</p></div><button class="btn secondary" data-close aria-label="Close account activity">Close</button></div><nav class="activity-tabs" aria-label="Account sections"></nav><div class="activity-content" aria-live="polite">Loading Stripe activity…</div></section>`;
    document.body.append(back);
    const drawer = back.querySelector('.activity-drawer');
    const close = () => { back.remove(); previousFocus?.focus(); };
    back.querySelector('[data-close]').onclick = close;
    back.onclick = e => { if (e.target === back) close(); };
    back.onkeydown = e => {
      if (e.key === 'Escape') close();
      if (e.key === 'Tab') {
        const focusable = [...back.querySelectorAll('button:not(:disabled),a,input,summary,[tabindex="0"]')];
        const first = focusable[0], last = focusable.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    drawer.focus();
    let data, charges = [], tab = 'Overview';
    const content = back.querySelector('.activity-content');
    const render = () => {
      if (!back.isConnected) return;
      back.querySelector('.activity-tabs').innerHTML = ['Overview', 'Sales', 'Payouts', 'Refunds', 'Disputes'].map(name => `<button class="tab ${tab === name ? 'active' : ''}" data-section="${name}">${name}</button>`).join('');
      back.querySelectorAll('[data-section]').forEach(button => button.onclick = () => { tab = button.dataset.section; render(); });
      const warnings = Object.entries(data.errors).map(([name, error]) => `<p class="activity-warning">${text(name)}: ${text(error)}</p>`).join('');
      let body = '';
      if (tab === 'Overview') {
        const pending = (data.transactions?.data || []).filter(t => t.status === 'pending');
        const upcoming = (data.payouts?.data || []).filter(p => ['pending', 'in_transit'].includes(p.status)).sort((a, b) => a.arrival_date - b.arrival_date);
        const schedule = data.account?.schedule;
        body = `<div class="activity-metrics">${['available', 'pending'].map(kind => `<article><span>${kind} balance</span>${(data.balance?.[kind] || []).map(b => `<strong>${amount(b.amount, b.currency)}</strong>`).join('') || '<strong>Unavailable</strong>'}</article>`).join('')}<article><span>Confirmed bank arrival</span><strong>${upcoming[0] ? date(upcoming[0].arrival_date) : 'No payout created yet'}</strong></article><article><span>Automatic schedule</span><strong>${text(schedule?.interval || 'Unavailable')}</strong><small>${schedule?.delay_days != null ? `${text(schedule.delay_days)} day settlement delay` : ''}</small></article></div><h3>Pending funds</h3><p class="activity-help">Availability is when funds enter the Stripe available balance. It does not confirm a bank payout date. Dates use your device timezone.</p>${rows(pending, ['Source', 'Net amount', 'Funds available', 'Status'], t => [text(t.source), amount(t.net, t.currency), date(t.available_on), text(t.status)])}<h3>Account status</h3><p>Payments: ${data.account?.charges_enabled ? 'Enabled' : 'Disabled / unavailable'} · Payouts: ${data.account?.payouts_enabled ? 'Enabled' : 'Disabled / unavailable'}</p><details><summary>Requirements and account details</summary><pre>${text(JSON.stringify(data.account, null, 2))}</pre></details>`;
      }
      if (tab === 'Sales') {
        body = `<div class="activity-filter"><input aria-label="Search loaded transactions" placeholder="Search ID, customer, email or amount" id="activity-search"><span>${charges.length} loaded transactions</span></div>${rows(charges, ['Date', 'Customer / IDs', 'Amount', 'Refunded', 'Fee / net', 'Funds available', 'Status', 'Details'], c => {
          const tx = typeof c.balance_transaction === 'object' ? c.balance_transaction : null;
          return [date(c.created), `<strong>${text(c.billing_details?.name || 'Customer unavailable')}</strong><small>${text(c.billing_details?.email || c.receipt_email)}</small><code>${text(c.id)}</code><code>${text(ref(c.payment_intent))}</code>`, amount(c.amount, c.currency), amount(c.amount_refunded, c.currency), tx ? `${amount(tx.fee, tx.currency)}<small>Net ${amount(tx.net, tx.currency)}</small>` : 'Unavailable', tx ? date(tx.available_on) : 'Unavailable', text(c.status), `<details><summary>View details</summary><dl>${Object.entries({Charge:c.id,PaymentIntent:ref(c.payment_intent),Customer:ref(c.customer),Invoice:ref(c.invoice),Card:`${c.payment_method_details?.card?.brand || ''} ${c.payment_method_details?.card?.last4 || ''}`,Captured:c.captured,Disputed:c.disputed,'Failure reason':c.failure_message,'Risk level':c.outcome?.risk_level,Description:c.description}).map(([k,v]) => `<dt>${text(k)}</dt><dd>${text(v)}</dd>`).join('')}</dl><details><summary>All available charge fields</summary><pre>${text(JSON.stringify(c,null,2))}</pre></details></details>`];
        })}${data.charges?.has_more ? '<button class="btn secondary" data-more>Load older transactions</button>' : '<p class="activity-help">End of charge history.</p>'}`;
      }
      if (tab === 'Payouts') body = rows(data.payouts?.data || [], ['Payout ID', 'Amount', 'Status', 'Bank arrival', 'Created', 'Destination', 'Failure'], p => [text(p.id), amount(p.amount,p.currency), text(p.status), date(p.arrival_date), date(p.created), text(ref(p.destination)), text(p.failure_message || p.failure_code)]);
      if (tab === 'Refunds') body = rows(data.refunds?.data || [], ['Refund ID','Charge','PaymentIntent','Amount','Status','Created','Failure'], r => [text(r.id),text(ref(r.charge)),text(ref(r.payment_intent)),amount(r.amount,r.currency),text(r.status),date(r.created),text(r.failure_reason)]);
      if (tab === 'Disputes') body = rows(data.disputes?.data || [], ['Dispute ID','Charge','Amount','Reason','Status','Evidence due'], d => [text(d.id),text(ref(d.charge)),amount(d.amount,d.currency),text(d.reason),text(d.status),date(d.evidence_details?.due_by)]);
      content.innerHTML = warnings + body + `<p class="activity-help">Last loaded ${text(new Date(data.checked_at).toLocaleString())}. Refunds, disputes and payouts show the latest records; sales history supports pagination.</p>`;
      const search = content.querySelector('#activity-search');
      if (search) search.oninput = () => content.querySelectorAll('tbody tr').forEach(row => { row.hidden = !row.textContent.toLowerCase().includes(search.value.toLowerCase()); });
      const more = content.querySelector('[data-more]');
      if (more) more.onclick = async () => {
        more.disabled = true; more.textContent = 'Loading…';
        try { const page = await api('GET', `/accounts/${id}/activity?after=${encodeURIComponent(charges.at(-1).id)}`); if(page.errors.charges) throw new Error(page.errors.charges); charges.push(...page.charges.data); data.charges = page.charges; render(); }
        catch (error) { more.disabled = false; more.textContent = 'Retry loading'; toast(error.message, true); }
      };
    };
    try { data = await api('GET', `/accounts/${id}/activity`); charges = data.charges?.data || []; render(); }
    catch (error) { content.textContent = error.message; }
  });
})();
