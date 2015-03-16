module.exports = function(raja, session) {
	var Store = session.Store;

	function RajaSessionStore(opts) {
		this.opts = opts || {};
		this.maxage = opts.maxage || 3600 * 24; // defaults to one-day session
		Store.call(this, opts);
	}

	require('util').inherits(RajaSessionStore, Store);

	RajaSessionStore.prototype.get = function(sid, cb) {
		var key = getKey(sid);
		raja.store.get(key, function(err, resource) {
			if (err || !resource) return cb(err);
			if (resource.mtime.getTime() + resource.maxage * 1000 > Date.now()) {
				cb(null, JSON.parse(resource.data.toString()));
			} else {
				raja.store.del(key, cb);
			}
		});
	};

	RajaSessionStore.prototype.set = function(sid, session, cb) {
		var key = getKey(sid);
		raja.store.get(key, function(err, resource) {
			if (err) return cb(err);
			if (!resource) resource = { key: key };

			resource.mtime = new Date();
			resource.maxage = session.cookie.maxAge / 1000 || this.maxage;
			resource.data = JSON.stringify(session);
			raja.store.set(key, resource);
			cb();
		}.bind(this));
	};

	RajaSessionStore.prototype.destroy = function(sid, cb) {
		raja.store.del(getKey(sid), cb);
	};

	function getKey(sid) {
		return 'sid:' + sid;
	}

	return RajaSessionStore;
};
