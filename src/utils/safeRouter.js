// An async route handler that throws produces an unhandled promise rejection,
// and Node exits on those — so one bad query in one admin screen takes the
// whole backend down for every customer and worker mid-job. That has happened
// twice in production already.
//
// This wraps every handler on a router once, so a thrown error is passed to
// Express instead: the person making that request gets a 500, the reason is
// logged, and everyone else carries on.
//
// Usage, directly after creating the router:
//
//   const router = express.Router();
//   makeSafe(router);
//
// Existing try/catch blocks still work and still give better messages — this
// is the net underneath them, not a replacement.

const METHODS = ["get", "post", "put", "patch", "delete"];

function makeSafe(router) {
  for (const method of METHODS) {
    if (typeof router[method] !== "function") continue;
    const original = router[method].bind(router);

    router[method] = (path, ...handlers) =>
      original(
        path,
        ...handlers.map((handler) => {
          // Express identifies error middleware by arity (err, req, res, next),
          // so those must be passed through untouched.
          if (typeof handler !== "function" || handler.length >= 4) return handler;

          return function safeHandler(req, res, next) {
            try {
              const result = handler(req, res, next);
              if (result && typeof result.then === "function") {
                result.catch(next);
              }
              return result;
            } catch (err) {
              next(err);
            }
          };
        })
      );
  }
  return router;
}

module.exports = { makeSafe };
