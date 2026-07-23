// ホーム職員としてログイン済みかチェック
function requireHomeLogin(req, res, next) {
  if (req.session && req.session.homeId) {
    return next();
  }
  return res.redirect('/login');
}

// 本部管理者としてログイン済みかチェック
function requireAdminLogin(req, res, next) {
  if (req.session && req.session.isAdmin) {
    return next();
  }
  return res.redirect('/admin/login');
}

module.exports = { requireHomeLogin, requireAdminLogin };
