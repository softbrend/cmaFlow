function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  req.session.flashError = 'Please sign in to continue.';
  return res.redirect('/login');
}

function redirectIfAuthed(req, res, next) {
  if (req.session && req.session.userId) {
    return res.redirect('/');
  }
  return next();
}

// Makes the logged-in account available to every view as `currentUser`.
function attachUser(req, res, next) {
  res.locals.currentUser = req.session.user || null;
  next();
}

module.exports = { requireAuth, redirectIfAuthed, attachUser };
