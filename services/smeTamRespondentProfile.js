// Respondent profile for SME Owner-TAM Evaluators (added 10 October 2026):
// the respondent's position in the business and their level of involvement
// in business decision-making. Added to answer the journal editor's concern
// about the organizational relevance of the evaluators — it lets the TAM
// results be reported for primary SME decision-makers separately.
//
// Captured on the /smeOwnerTam-signup form for new accounts. Accounts that
// registered before this existed are sent to /smeOwnerTam/profile on their
// next page load (middleware/respondentProfileGate.js) and must answer both
// questions before they can continue. Only this role is affected.

const OTHER_POSITION = 'Other Business Decision-Maker';

const POSITIONS = [
  'Business Owner / Proprietor',
  'Co-Owner / Business Partner',
  'Owner-Manager',
  'General Manager',
  'Operations Manager',
  'Finance Manager',
  'Sales Manager',
  'Marketing Manager',
  'Branch Manager',
  'Business Development Manager',
  'Accounting Manager / Bookkeeper',
  'Administrative Manager',
  'Production / Inventory Manager',
  'IT Manager / Digital Transformation Officer',
  OTHER_POSITION,
];

// primary: true marks the three levels prioritized for the primary SME
// decision-maker analysis.
const DECISION_AUTHORITY = [
  { value: 'Primary Decision-Maker', description: 'Makes final business decisions.', primary: true },
  { value: 'Joint Decision-Maker', description: 'Shares responsibility for business decisions.', primary: true },
  { value: 'Departmental Decision-Maker', description: 'Makes decisions within a specific business function.', primary: true },
  { value: 'Decision-Support Personnel', description: 'Analyzes information and provides recommendations to management.', primary: false },
  { value: 'Operational Staff', description: 'Uses business information but has limited decision-making authority.', primary: false },
];

const PRIMARY_AUTHORITY_VALUES = DECISION_AUTHORITY.filter((d) => d.primary).map((d) => d.value);

function isValidPosition(value) {
  return POSITIONS.includes(value);
}

function isValidAuthority(value) {
  return DECISION_AUTHORITY.some((d) => d.value === value);
}

function isPrimaryDecisionMaker(authority) {
  return PRIMARY_AUTHORITY_VALUES.includes(authority);
}

// What to show for a respondent's position — the "please specify" text
// when they chose Other.
function displayPosition(position, other) {
  if (!position) return null;
  if (position === OTHER_POSITION && other) return `${OTHER_POSITION}: ${other}`;
  return position;
}

function isProfileComplete(account) {
  if (!account) return false;
  if (!isValidPosition(account.respondent_position)) return false;
  if (account.respondent_position === OTHER_POSITION && !(account.respondent_position_other || '').trim()) return false;
  return isValidAuthority(account.decision_authority);
}

module.exports = {
  OTHER_POSITION,
  POSITIONS,
  DECISION_AUTHORITY,
  PRIMARY_AUTHORITY_VALUES,
  isValidPosition,
  isValidAuthority,
  isPrimaryDecisionMaker,
  displayPosition,
  isProfileComplete,
};
