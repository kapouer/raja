var q = require('queue-async');

// initialize io, store
// invalid cache upon message reception

module.exports = function(opts, cb) {
	var raja = new Raja();
	raja.proxies = {
		local: require('./proxies/local'),
		remote: require('./proxies/remote'),
		express: require('./proxies/express'),
		dom: require('./proxies/dom')
	};
	raja.init(opts, cb);
	return raja;
};

function Raja() {}

Raja.prototype.init = function(opts, cb) {
	q(2)
	.defer(require('./io'), this, opts.io)
	.defer(require('./store'), this, opts.store)
	.await(function(err, io, store) {
		if (err) return cb(err);
		if (!io) return cb(new Error("raja failed to init io"));
		if (!store) return cb(new Error("raja failed to init store"));
		this.io = io;
		this.store = store;
		cb(null, this);
	}.bind(this));
};

// internal function
Raja.prototype.receive = function(msg) {
	this.store.invalidateParents(msg.url, function(err) {
		if (err) console.error(err);
	});
};

Raja.prototype.send = function(msg, cb) {
	if (!msg.mtime) msg.mtime = Date.now();
	this.io.send(msg, cb);
};

Raja.prototype.error = function(err) {
	// called when an error happened while using raja
	if (err) console.error(err);
};

