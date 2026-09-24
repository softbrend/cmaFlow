function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  req.session.flashError = 'Please sign in to continue.';
  return res.redirect('/login');
}

// Same session check as requireAuth, plus role === 'Admin'. A signed-in
// non-admin (e.g. an SME owner who guesses an /admin URL) gets a plain
// 403 rather than being bounced back to /login — they ARE authenticated,
// just not authorized for this section.
function requireAdmin(req, res, next) {
  if (!(req.session && req.session.userId)) {
    req.session.flashError = 'Please sign in to continue.';
    return res.redirect('/login');
  }
  if (req.session.user && req.session.user.role === 'Admin') {
    return next();
  }
  return res.status(403).render('errors/403', { title: 'Not authorized', layout: false });
}

function redirectIfAuthed(req, res, next) {
  if (req.session && req.session.userId) {
    return res.redirect(req.session.user && req.session.user.role === 'Admin' ? '/admin' : '/');
  }
  return next();
}

// Makes the logged-in account available to every view as `currentUser`.
function attachUser(req, res, next) {
  res.locals.currentUser = req.session.user || null;
  next();
}

module.exports = {
  requireAuth, requireAdmin, redirectIfAuthed, attachUser,
};
