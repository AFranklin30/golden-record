'use strict';

function requireOperator(...allowedRoles) {
  return function roleGuard(req, res, next) {
    // RECEIVE
    const ctx = req.context;

    // GUARD
    if (!ctx || ctx.principal_type !== 'operator' || !ctx.operator_id) {
      return res.status(403).json({
        error: 'forbidden',
        message: 'operator authentication required',
      });
    }
    if (allowedRoles.length > 0 && !allowedRoles.includes(ctx.operator_role)) {
      return res.status(403).json({
        error: 'forbidden',
        message: 'insufficient operator permissions',
      });
    }

    // RETURN
    return next();
  };
}

function requireHumanReviewer(req, res, next) {
  // RECEIVE
  const ctx = req.context;

  // GUARD
  if (!ctx || ctx.principal_type !== 'operator' || !ctx.operator_id) {
    return res.status(403).json({
      error: 'forbidden',
      message: 'integrations cannot perform human conflict-review actions',
    });
  }
  if (ctx.operator_role !== 'admin' && ctx.operator_role !== 'operator') {
    return res.status(403).json({
      error: 'forbidden',
      message: 'insufficient operator permissions',
    });
  }

  // RETURN
  return next();
}

module.exports = {
  requireOperator,
  requireHumanReviewer,
};
