var request = require('request');
var URL = require('url');

for (var method in {GET:1, PUT:1, POST:1, DELETE:1}) {
	exports[method] = (function(method) { return function(url, query, body, cb) {
		if (!cb) {
			if (typeof body == "function") {
				cb = body;
				body = null;
			} else if (typeof query == "function") {
				cb = query;
				query = null;
			} else {
				cb = function(err) {
					if (err) console.error(err);
				};
			}
		}
		var headers = {
			Accept: 'application/json'
		};

		if (/^(HEAD|GET|COPY)$/i.test(method)) {
			query = query || body || {};
		} else {
			// give priority to body
			if (!body && query) {
				body = query;
				query = null;
			}
		}
		// consume parameters from query object
		url = substitute(url, query);
		var parsed = URL.parse(url);
		if (parsed.auth) {
			headers['Authorization'] = 'Basic ' + new Buffer(parsed.auth).toString('base64');
			parsed.auth = null;
		}
		if (query && Object.keys(query).length) parsed.query = query;
		url = URL.format(parsed);

		var opts = {
			method: method,
			url: url,
			headers: headers,
			json: true
		};
		if (body) opts.body = body;

		return request(opts, function(err, res, body) {
			var code = res && res.statusCode || 0;
			if (code >= 200 && code < 400) {
				cb(null, body);
			} else {
				if (!err) err = new Error("Request agent code " + code);
				err.code = code;
				cb(err);
			}
		});
	};})(method);
}

exports.resolve = resolve;
function resolve(loc, url) {
	if (/^https?/i.test(url)) return url;
	if (typeof loc == "string") loc = URL.parse(loc);
	var path = loc.pathname || loc.path;
	if (url && url.substring(0, 1) == '/') {
		path = url;
	} else {
		var adds = url.split('/');
		var comps = path.split('/');
		var prev = comps.pop();
		while (adds.length) {
			var toAdd = adds.shift();
			last = comps.pop();
			if (toAdd == '..') {
				// do not add last back
			} else if (toAdd == '.') {
				comps.push(last);
				if (prev != '') comps.push(prev);
			} else {
				comps.push(last);
				comps.push(toAdd);
			}
		}
		path = comps.join('/');
	}
	var pcl = loc.protocol;
	if (pcl && pcl.slice(-1) != ':') pcl += ':';
	var host = typeof loc.get == "function" ? loc.get('Host') : loc.host;
	url = pcl + '//' + host + path;
	return url;
}

exports.substitute = substitute;
function substitute(url, params) {
	if (!params) return url;
	return url.replace(/\/:(\w+)/g, function(str, name) {
		var val = params[name];
		if (val != null) {
			delete params[name];
			return '/' + val;
		} else {
			return '/:' + name;
		}
	});
}

exports.append = append;
function append(url, query) {
	if (!query) return url;
	var comps = [];
	var str;
	for (var k in query) {
		str = encodeURIComponent(k);
		if (query[k] != null) str += '=' + encodeURIComponent(query[k]);
		comps.push(str);
	}
	if (comps.length) {
		if (url.indexOf('?') > 0) url += '&';
		else url += '?';
		url += comps.join('&');
	}
	return url;
}
