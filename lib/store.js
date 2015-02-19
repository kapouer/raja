var orm = require('orm');
var queue = require('queue-async');
var LFU = require('lfu-cache');

module.exports = function(raja, opts, cb) {
	var store = new Store(raja, opts);
	orm.connect(opts.store, function(err, db) {
		if (err) return cb(err);
		store.init(db, cb);
	});
};

function Store(raja, opts) {
	this.raja = raja;
	this.lfu = new LFU(opts.cacheSize || 500, opts.cacheDecay || 60000);
	this.lfu.on('eviction', function(key, obj) {
		this.Resource.one(obj.url, function(err, res) {
			if (err) return raja.error(err);
			if (!res) res = new (this.Resource)();
			// alter obj since it is evicted anyway
			var resources = obj.resources;
			if (resources) delete obj.resources;
			var parents = obj.parents;
			if (parents) delete obj.parents;
			// delete obj.itime ? in general, delete keys not in schema ?
			res.save(obj, function(err) {
				if (err) return raja.error(err);
				var q = queue(2);
				if (resources) q.defer(saveResource.bind(this), res, resources, true);
				if (parents) q.defer(saveParents.bind(this), res, parents, false);
				q.awaitAll(function(err) {
					if (err) raja.error(err);
				});
			}.bind(this));
		}.bind(this));
	});
}

Store.prototype.init = function(db, cb) {
	var Resource = this.Resource = db.define('Resource', {
		url: { type: 'text', index: true },
		mtime: { type: 'date', time: true, index: true },
		maxage: { type: 'integer' },
		headers: { type: 'object' },
		valid: { type: 'boolean', defaultValue: true },
		data: { type: 'binary' },
		code: { type: 'integer', defaultValue: 200 }
	}, {
		table: "raja_cached_resources",
		cache: false, // we cache better :)
		hooks: {
			beforeSave: beforeSaveResource
		},
	});

	Resource.hasMany("children", Resource, {}, {
		reverse : "parents",
		key: true
	});

	var store = this;

	queue(1)
	.defer(Resource.drop)
	.defer(Resource.sync)
	.awaitAll(function(err) {
		cb(err, store);
	});
};

function beforeSaveResource() {
	if (typeof this.data == "string") {
		this.data = new Buffer(this.data);
	}
	if (this.valid == null && this.data != null) {
		this.valid = true;
	} else if (this.valid != null && this.data == null) {
		this.valid = false;
	}
	if (!this.headers) this.headers = {};
	this.mtime = new Date();
}

Store.prototype.get = function(url, cb) {
	var lfuObj = this.lfu.get(url);
	if (lfuObj) {
		if (lfuObj.valid) return cb(null, lfuObj);
		else return cb();
	}
	this.Resource.one({url: url}, function(err, obj) {
		if (obj) {
			var lfuObj = this.raja.shallow(obj);
			queue(2)
			.defer(getRelations, obj, lfuObj, true)
			.defer(getRelations, obj, lfuObj, false)
			.awaitAll(function(err) {
				if (err) return cb(err);
				this.lfu.set(url, lfuObj);
				cb(err, lfuObj);
			}.bind(this));
		} else {
			cb(err);
		}
	}.bind(this));
};

Store.prototype.del = function(url, cb) {
	this.lfu.remove(url);
	this.Resource.find({url: url}).remove(cb);
};

Store.prototype.invalidate = function(url, cb) {
	// what happens if it does not find any resource ?
	var lfuObj = this.lfu.get(url);
	if (lfuObj) {
		lfuObj.valid = false;
	}
	this.Resource.find({url: url}, function(err, rows) {
		if (err) return cb(err);
		if (rows.length > 1) return cb(new Error("invalidate expects only one resource at " + url));
		else if (rows.length == 0) return cb();
		rows[0].valid = false;
		rows[0].save(cb);
	});
};

Store.prototype.invalidateParents = function(msg, cb) {
	var raja = this.raja;
	var url = msg.parents.slice(-1).pop() || msg.url;
	var lfu = this.lfu;
	var lfuObj = lfu.get(url);
	var lfuParents = lfuObj && lfuObj.parents;
	var onlyCache = true;
	var sentMsg = {};
	if (lfuParents) for (var rurl in lfuParents) {
		var robj = lfu.get(rurl);
		if (robj) {
			robj.valid = false; // robj is a pointer to the object in lfu, no need to lfu.set
			var cmsg = raja.shallow(msg);
			cmsg.parents = msg.parents.slice();
			cmsg.parents.push(rurl);
			sentMsg[rurl] = true;
			raja.send(cmsg);
		} else {
			onlyCache = false;
		}
	} else {
		onlyCache = false;
		lfuParents = {};
	}

	if (onlyCache) return cb();

	this.Resource.find({url: url}, function(err, rows) {
		if (err) return cb(err);
		if (rows.length > 1) return cb(new Error("invalidateParents expects only one resource at " + url));
		else if (rows.length == 0) return cb();
		var res = rows[0];
		res.getParents().each(function(par) {
			if (sentMsg[par.url]) return; // already dealt with
			var lfuObj = lfu.get(par.url);
			if (lfuObj) lfuObj.valid = false;
			par.valid = false;
			var cmsg = raja.shallow(msg);
			cmsg.parents = msg.parents.slice();
			cmsg.parents.push(par.url);
			raja.send(cmsg);
		}).save(cb);
	});
};

Store.prototype.set = function(url, obj, cb) {
	if (!cb && typeof obj == "function") {
		cb = obj;
		obj = null;
	}
	if (!obj) obj = {};
	if (!obj.url) obj.url = url;
	var lfu = this.lfu;
	var lfuObj = lfu.get(url);
	// first remove previous associations
	if (obj.resources && lfuObj && lfuObj.resources) for (var rurl in lfuObj.resources) {
		var robj = lfu.get(rurl);
		if (robj && robj.parents) delete robj.parents[url];
	}
	lfuObj = this.raja.shallow(obj, lfuObj || {});
	// then add new associations
	if (obj.resources && lfuObj.resources) for (var rurl in lfuObj.resources) {
		var robj = lfu.get(rurl);
		if (!robj) {
			robj = {url: rurl};
			beforeSaveResource.call(robj);
			lfu.set(rurl, robj);
		}
		if (!robj.parents) {
			robj.parents = {};
		}
		robj.parents[url] = true;
	}
	beforeSaveResource.call(lfuObj);
	this.lfu.set(url, lfuObj);
	// this api should not be async
	cb(null, lfuObj);
};

function saveRelations(inst, hash, isChildren, cb) {
	var self = this;
	this.Resources.find({url: Object.keys(hash)}).run(function(err, rows) {
		if (err) return cb(err);
		var notfound = self.raja.shallow(hash);
		rows.forEach(function(row) {
			delete notfound[row.url];
		});
		var q = queue(3);
		for (var rurl in notfound) {
			q.defer(function(rurl, cb) {
				(new self.Resource({url: rurl})).save(cb);
			}, rurl);
		}
		q.awaitAll(function(err, savedRows) {
			var total = rows.concat(savedRows);
			if (isChildren) inst.setChildren(total, cb);
			else inst.setParents(total, cb);
		});
	});
}

function getRelations(inst, lfuObj, isChildren, cb) {
	var hash, method;
	if (isChildren) {
		hash = lfuObj.resources = {};
		method = obj.getChildren;
	} else {
		hash = lfuObj.parents = {};
		method = obj.getParents;
	}
	method.call(obj, function(err, rows) {
		if (err) return cb(err);
		rows.forEach(function(row) {
			hash[row.url] = true;
		});
		cb();
	});
}

