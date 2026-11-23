// Local review-server adapter. Hosted consumers provide their own callbacks.
if (window.top === window) {
  const endpoint = __ENDPOINT__;
  const saveDraft = async payload => {
    const response = await fetch(`${endpoint}/draft`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload), keepalive: true,
    });
    if (!response.ok) throw new Error(await response.text());
  };
  createHtmlReview({
    initialComments: __INITIAL_COMMENTS__,
    saveDraft,
    flushOnPageHide(payload) {
      const body = JSON.stringify(payload);
      const queued = navigator.sendBeacon && navigator.sendBeacon(`${endpoint}/draft`, new Blob([body], {type: 'application/json'}));
      if (!queued) return saveDraft(payload);
    },
    async onFinish(action) {
      const response = await fetch(`${endpoint}/${action}`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
      if (!response.ok) throw new Error(await response.text());
      document.documentElement.innerHTML = `<head><title>Review ${action === 'submit' ? 'submitted' : 'cancelled'}</title></head><body style="font:16px/1.5 system-ui;padding:3rem"><h1>Review ${action === 'submit' ? 'submitted' : 'cancelled'}</h1><p>You can close this tab.</p></body>`;
    },
  });
}
