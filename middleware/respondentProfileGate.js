// Sends an SME Owner-TAM Evaluator whose respondent profile is incomplete
// (position in the business and decision-making involvement — see
// services/smeTamRespondentProfile.js) to /smeOwnerTam/profile before any
// other page (added 10 October 2026). New accounts answer both questions on
// the signup form, so this only ever catches accounts that registered
// before the questions existed — on their next login, or on their next page
// load if they are still signed in. No other role is affected.
const { SME_TAM_ROLE } = require('../services/tamEvaluation');
const { isProfileComplete } = require('../services/smeTamRespondentProfile');

const PROFILE_PATH = '/smeOwnerTam/profile';
const ALWAYS_ALLOWED = [PROFILE_PATH, '/logout', '/healthz', '/login'];

function respondentProfileGate(req, res, next) {
  const user = req.session && req.session.user;
  if (!user || user.role !== SME_TAM_ROLE) return next();
  if (isProfileComplete(user)) return next();
  if (ALWAYS_ALLOWED.some((p) => req.path === p || req.path.startsWith(`${p}/`))) return next();
  // Only redirect page loads; let background/JSON requests through untouched
  // so an open tab's polling never breaks.
  if (req.method !== 'GET' || req.xhr || (req.get('accept') || '').indexOf('text/html') === -1) return next();
  return res.redirect(PROFILE_PATH);
}

module.exports = { respondentProfileGate, PROFILE_PATH };
