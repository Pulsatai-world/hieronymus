/* Prompts where no engine cited the client at all — the actionable half of the diagnosis.
 *
 * Brand-cluster prompts are excluded: a prompt that names the company is not a place the company
 * could be "invisible".
 */
AkoreBlocks.define('invisiblePrompts', {
  render(ctx) {
    const { rows, t, esc, promptMap, doc } = ctx;
    const invByPrompt = {};
    rows.filter(r => r.topic_cluster !== 'Brand').forEach(r => {
      (invByPrompt[r.prompt_id] = invByPrompt[r.prompt_id] || []).push(r);
    });
    const invisible = Object.keys(invByPrompt).filter(pid => invByPrompt[pid].every(r => !r.brand_cited)).sort();

    const invSec = doc.createElement('div'); invSec.className = 'cat';
    let invHtml = `<div class="cat-h"><div class="cat-titles"><span class="q">${t('invisibleTitle')}</span><span class="ask">${t('invisibleSub')}</span></div><span class="cat-note">${t('invisibleCount', invisible.length)}</span></div>`;
    if (invisible.length === 0) { invHtml += `<div class="empty">${t('invisibleNone')}</div>`; }
    else {
      invHtml += `<div class="invlist">` + invisible.map(pid => `<div class="invrow"><span class="code">${esc(pid)}</span><span class="invtxt">${esc(promptMap[pid] || '')}</span></div>`).join('') + `</div>`;
    }
    invSec.innerHTML = invHtml;
    return invSec;
  }
});
