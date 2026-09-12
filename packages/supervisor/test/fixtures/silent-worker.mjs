// Never reports ready — stands in for the restart window.
process.on('disconnect', () => process.exit(0));
setInterval(() => {}, 1000).unref();
