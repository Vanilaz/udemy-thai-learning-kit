// Runs in the PAGE's own world on YouTube, at document_start.
//
// YouTube now refuses to serve a caption track unless the request carries a
// `pot` value — a Proof of Origin Token it mints for its own player. Ask for a
// track without one and the server answers 200 with an empty body, which is
// why fetching `baseUrl` straight from the caption list quietly returned
// nothing at all.
//
// The token cannot be computed from outside the player, but it is right there
// in the query string of every request the player makes. So both network entry
// points are wrapped, and whatever `pot` goes past is handed to the content
// script through a DOM event — the one channel the page world and an isolated
// world both reach.
//
// Nothing is blocked or altered here: the original function is always called
// with the original arguments.
(() => {
  "use strict";

  const EVENT = "udth:pot";
  let seen = null;

  const publish = (url) => {
    let token = null;
    try {
      token = new URL(url, location.origin).searchParams.get("pot");
    } catch {
      return; // relative or malformed URL — nothing to read
    }
    if (!token || token === seen) return;
    seen = token;
    window.dispatchEvent(new CustomEvent(EVENT, { detail: token }));
  };

  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      publish(url);
    } catch {
      /* never let instrumentation break the player */
    }
    return open.call(this, method, url, ...rest);
  };

  // The player uses fetch for some requests too, and which one carries the
  // token varies between YouTube builds.
  const fetcher = window.fetch;
  if (typeof fetcher === "function") {
    window.fetch = function (input, ...rest) {
      try {
        publish(typeof input === "string" ? input : input && input.url);
      } catch {
        /* as above */
      }
      return fetcher.call(this, input, ...rest);
    };
  }
})();
