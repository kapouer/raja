var q = require('queue-async');

// initialize io, store
// invalid cache upon message reception

module.exports = function(opts, cb) {
	var raja = new Raja(opts);
	raja.error = Raja.prototype.error.bind(raja);
	raja.proxies = {
		local: require('./proxies/local').bind(null, raja),
		remote: require('./proxies/remote').bind(null, raja),
		"static": require('./proxies/static').bind(null, raja),
		express: require('./proxies/express').bind(null, raja),
		dom: require('./proxies/dom').bind(null, raja)
	};
	raja.init(function(err) {
		cb(err, raja);
	});
	return raja;
};

function Raja(opts) { this.opts = opts || {}; }

Raja.prototype.init = function(cb) {
	q(2)
	.defer(require('./io'), this, this.opts.io)
	.defer(require('./store'), this, this.opts.store)
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
	this.store.invalidateParents(msg, function(err) {
		if (err) console.error(err);
	});
};

Raja.prototype.send = function(msg) {
	if (!msg.url) {
		return this.error(new Error("missing msg.url in " + msg));
	}
	if (!msg.mtime) msg.mtime = Date.now();
	this.io.send(msg);
};

Raja.prototype.error = function(err) {
	// called when an error happened while using raja
	if (err) console.error(err);
};

Raja.prototype.shallow = function(src) {
	var dst = {};
	for (var key in src) dst[key] = src[key];
	return dst;
};
