// Reports ready over IPC, serves nothing, exits when the channel closes.
process.send({ type: 'ready', pid: process.pid });
process.on('disconnect', () => process.exit(0));
setInterval(() => {}, 1000).unref();
