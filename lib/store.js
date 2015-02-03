var orm = require('orm');
var q = require('queue-async');
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
			var resources = obj.resources;
			if (resources) delete obj.resources;
			var parents = obj.parents;
			if (parents) delete obj.parents;
			res.save(obj, function(err) {
				if (err) return raja.error(err);
				if (resources || parents) saveRelations.call(this, res, resources, parents, raja.error);
			}.bind(this));
		}.bind(this));
	});
}

Store.prototype.init = function(db, cb) {
	var Resource = this.Resource = db.define('Resource', {
		url: { type: 'text', index: true },
		mtime: { type: 'date', time: true, index: true },
		maxage: { type: 'integer' },
		etag: { type: 'text' },
		valid: { type: 'boolean', defaultValue: true },
		data: { type: 'binary' },
		code: { type: 'integer', defaultValue: 200 },
		mime: { type: 'text' }
	}, {
		table: "raja_cached_resources",
		cache: false,
		hooks: {
			beforeSave: beforeSaveResource
		},
	});
	Resource.hasMany("children", Resource, {}, {
		reverse : "parents",
		key: true
	});
	var store = this;
	Resource.drop(function(err) {
		if (err) console.error(err);
		Resource.sync(function(err) {
			cb(err, store);
		});
	});
};

function beforeSaveResource() {
	if (typeof this.data == "string") this.data = new Buffer(this.data);
	if (this.valid == null && this.data != null) this.valid = true;
	else if (this.valid != null && this.data == null) this.valid = false;
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
			this.lfu.set(url, this.raja.shallow(obj));
		}
		cb(err, obj);
	}.bind(this));
};

Store.prototype.del = function(url, cb) {
	this.lfu.remove(url);
	this.Resource.find({url: url}).remove(cb);
};

Store.prototype.invalidate = function(url, cb) {
	// what happens if it does not find any resource ?
	var lfuObj = this.lfu.get(url);
	if (lfuObj) lfuObj.valid = false;
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
	if (obj.resources && lfuObj && lfuObj.resources) lfuObj.resources.forEach(function(rurl) {
		var robj = lfu.get(rurl);
		if (robj && robj.parents) delete robj.parents[url];
	});
	lfuObj = this.raja.shallow(obj, lfuObj || {});
	// then add new associations
	if (obj.resources && lfuObj.resources) lfuObj.resources.forEach(function(rurl) {
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
	});
	beforeSaveResource.call(lfuObj);
	this.lfu.set(url, lfuObj);
	cb(null, lfuObj);
};

function saveRelations(inst, resources, parents, cb) {
	var self = this;
	// for each resource, check if it exists
	// TODO save parents
	this.Resources.find({url: resources}).run(function(err, rows) {
		if (err) return cb(err);
		var notfound = {};
		resources.forEach(function(rurl) {
			notfound[rurl] = true;
		});
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
			inst.setChildren(rows.concat(savedRows), function(err) {
				cb(err, inst);
			});
		});
	});
}

