// Business Category summary for the SME Owner-TAM Evaluator population
// (added 10 October 2026). Groups every SME Owner-TAM Evaluator account by
// the SME business category declared at signup (sme_accounts.business_sector)
// and counts how many have COMPLETED the 17-item TAM questionnaire versus
// how many have NOT (split into "in progress" — questionnaire open — and
// "not started", which also covers consent pending/declined and accounts
// that never opened a session).
//
// Pure function over listAllSmeTamEvaluationStatuses() rows, so the
// numbers always agree with the Respondents table on the evaluation report
// page. Never mixes in any other population's accounts.
const { loadCategories } = require('./smeCategories');

const UNSPECIFIED = 'Not specified';

function classify(status) {
  if (status === 'completed') return 'completed';
  if (status === 'questionnaire' || status === 'walkthrough') return 'inProgress';
  return 'notStarted';
}

function buildCategorySummary(statuses) {
  let manifestOrder = [];
  try {
    manifestOrder = loadCategories().map((c) => c.name);
  } catch (e) {
    manifestOrder = [];
  }

  const byName = new Map();
  (statuses || []).forEach((s) => {
    const name = (s.business_sector || '').trim() || UNSPECIFIED;
    if (!byName.has(name)) {
      byName.set(name, {
        category: name, registered: 0, completed: 0, inProgress: 0, notStarted: 0,
        completedList: [], notCompletedList: [],
      });
    }
    const row = byName.get(name);
    const bucket = classify(s.status);
    row.registered += 1;
    row[bucket] += 1;
    const person = {
      account_id: s.account_id,
      owner_name: s.owner_name,
      username: s.username,
      business_size: s.business_size,
      state: bucket,
      items_answered: s.items_answered || 0,
      completed_at: s.completed_at || null,
    };
    if (bucket === 'completed') row.completedList.push(person);
    else row.notCompletedList.push(person);
  });

  const rows = Array.from(byName.values()).map((r) => ({
    ...r,
    notCompleted: r.inProgress + r.notStarted,
    completionRate: r.registered ? (r.completed / r.registered) * 100 : 0,
  }));

  // Most registrations first; ties follow the manifest's own category order.
  const orderIndex = (name) => {
    const i = manifestOrder.indexOf(name);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  rows.sort((a, b) => (b.registered - a.registered) || (orderIndex(a.category) - orderIndex(b.category)));

  const totals = rows.reduce((t, r) => {
    t.registered += r.registered;
    t.completed += r.completed;
    t.inProgress += r.inProgress;
    t.notStarted += r.notStarted;
    return t;
  }, { registered: 0, completed: 0, inProgress: 0, notStarted: 0 });
  totals.notCompleted = totals.inProgress + totals.notStarted;
  totals.completionRate = totals.registered ? (totals.completed / totals.registered) * 100 : 0;

  const represented = new Set(rows.map((r) => r.category));
  const uncovered = manifestOrder.filter((name) => !represented.has(name));

  return {
    rows,
    totals,
    categoriesRepresented: rows.filter((r) => r.category !== UNSPECIFIED).length,
    categoriesTotal: manifestOrder.length,
    uncovered,
  };
}

// Account id -> 'completed' | 'inProgress' | 'notStarted', for the
// per-account Evaluation column on the Manage SME Owner-TAM Evaluators page.
function statusByAccount(statuses) {
  const map = {};
  (statuses || []).forEach((s) => {
    map[s.account_id] = { state: classify(s.status), items_answered: s.items_answered || 0 };
  });
  return map;
}

module.exports = { buildCategorySummary, statusByAccount };
