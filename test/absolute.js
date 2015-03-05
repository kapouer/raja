var eq = require('assert').equal;

function conv(root, url) {
	var loc = require('url').parse(root);
	var path = loc.pathname;
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
	url = loc.protocol + '//' + loc.host + path;
	return url;
}


eq(conv('http://google.fr/test/moi', './ici/la'), 'http://google.fr/test/moi/ici/la');
eq(conv('http://google.fr/test/moi', 'ici/la'), 'http://google.fr/test/ici/la');
eq(conv('http://google.fr/test/moi', '/ici/la'), 'http://google.fr/ici/la');
eq(conv('http://giigle.fr/root/', './ici/la'), 'http://giigle.fr/root/ici/la');
eq(conv('http://giigle.fr/root/', '/ici/la'), 'http://giigle.fr/ici/la');
eq(conv('http://giigle.fr/a/b/c/d', './ici/la'), 'http://giigle.fr/a/b/c/d/ici/la');
eq(conv('http://giigle.fr/a/b/c/d', 'ici/la'), 'http://giigle.fr/a/b/c/ici/la');
eq(conv('http://giigle.fr/a/b/c/d', '../ici/la'), 'http://giigle.fr/a/b/ici/la');
eq(conv('http://giigle.fr/a/b/c/d', '../../ici/la'), 'http://giigle.fr/a/ici/la');
eq(conv('http://giigle.fr/a/b/c/d', '../../../ici/la'), 'http://giigle.fr/ici/la');
eq(conv('http://giigle.fr/a/b/c/d', '../../toto/../ici/la'), 'http://giigle.fr/a/ici/la');

