var queue = require('queue-async');

module.exports = function(raja, opts) {
	return domAuthorMinify.bind(null, raja, opts);
};

function domAuthorMinify(raja, opts, h, req, res) {
	h.page.run(function(done) {
		// inside DOM
		function populateMaps(maps, tagName, src, atts, type) {
			var nodes = Array.prototype.slice.call(document.querySelectorAll(tagName));
			nodes.forEach(function(node) {
				var minify = node.hasAttribute('minify');
				if (!minify) return;
				var single = false;
				var dest = node.getAttribute('minify');
				if (!dest) {
					single = true;
					dest = node[src].split('.');
					dest.push('min', dest.pop());
					dest = dest.join('.');
				}
				var map = maps[dest];
				if (!map) {
					var destNode = document.createElement(tagName);
					for (var name in atts) destNode[name] = atts[name];
					destNode[src] = dest;
					node.parentNode.insertBefore(destNode, node);
					map = maps[dest] = {list:[], url: destNode[src], single: single};
					for (var name in atts) map[name] = atts[name];
					if (type) map.type = type;
				}
				node.parentNode.removeChild(node);

				if (map.single && map.list.length == 1) throw new Error("cannot automatically name minified files with the same names", dest);
				else map.list.push(node[src]);
			});
		}
		var maps = {}, err = null;
		try {
			populateMaps(maps, 'script', 'src', {type:'text/javascript', charset:'utf-8'});
			populateMaps(maps, 'link', 'href', {type:'text/css', rel:'stylesheet'});
		} catch(e) {
			err = e;
		}
		done(err, maps);
	}, function(err, maps, donecb) {
		// inside NODEJS
		if (err) return donecb(err);
		if (Object.keys(maps).length == 0) return donecb();
		var q = queue(2);
		for (var path in maps) {
			var map = maps[path];
			var resource = raja.create(map.url);
			var type = map.type;
			if (map.charset) type += '; charset=' + map.charset;
			resource.headers = {};
			if (type) resource.headers['Content-Type'] = type;
			// not so useful - minified files already are declared as dependencies of the authorUrl
			// if (!resource.parents) resource.parents = {};
			// resource.parents[h.authorUrl] = true;
			q.defer(batch, resource, map.list);
		}
		q.awaitAll(function(err) {
			// do not pass the list of results
			donecb(err);
		});
	});
}

function batch(resource, list, cb) {
	var q = queue(2);
	list.forEach(function(rurl) {
		q.defer(function(cb) {
			resource.load(rurl, cb);
		});
	});
	q.awaitAll(function(err, datas) {
		if (err) return cb(err);
		resource.data = datas.join('\n');
		resource.save(cb);
	});
}
