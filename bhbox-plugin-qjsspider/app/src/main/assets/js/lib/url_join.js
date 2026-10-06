function _parseUri(uri) {
    if (!uri || uri === '') {
        return { schemeColon: -1, path: 0, query: 0, fragment: 0, str: '' };
    }

    var len = uri.length;

    // Fragment (rightmost)
    var fragmentIdx = uri.indexOf('#');
    if (fragmentIdx === -1) fragmentIdx = len;

    // Query (before fragment)
    var queryIdx = uri.indexOf('?');
    if (queryIdx === -1 || queryIdx > fragmentIdx) {
        queryIdx = fragmentIdx;
    }

    // Scheme colon (before first '/', limited to before query)
    var schemeLimit = uri.indexOf('/');
    if (schemeLimit === -1 || schemeLimit > queryIdx) {
        schemeLimit = queryIdx;
    }
    var schemeColon = uri.indexOf(':');
    if (schemeColon > schemeLimit) {
        schemeColon = -1; // '/' before ':' → not a scheme
    }

    // Authority detection: "://" after scheme
    var hasAuthority = (schemeColon + 2 < queryIdx &&
        uri.charAt(schemeColon + 1) === '/' &&
        uri.charAt(schemeColon + 2) === '/');

    var pathIdx;
    if (hasAuthority) {
        // Find first '/' after "://"
        pathIdx = uri.indexOf('/', schemeColon + 3);
        if (pathIdx === -1 || pathIdx > queryIdx) {
            pathIdx = queryIdx;
        }
    } else {
        pathIdx = schemeColon + 1;
    }

    return {
        schemeColon: schemeColon,
        path: pathIdx,
        query: queryIdx,
        fragment: fragmentIdx,
        str: uri
    };
}

function _removeDotSegments(uri, offset, limit) {
    if (offset >= limit) return uri;

    var chars = uri.split('');
    var pathStart = offset;

    // If path starts with '/', retain it
    if (chars[offset] === '/') {
        offset++;
    }

    var segmentStart = offset;
    var i = offset;

    while (i <= limit) {
        var nextSegmentStart;
        if (i === limit) {
            nextSegmentStart = i;
        } else if (chars[i] === '/') {
            nextSegmentStart = i + 1;
        } else {
            i++;
            continue;
        }

        // Check for "." segment
        if (i === segmentStart + 1 && chars[segmentStart] === '.') {
            // Remove "./"
            var removeLen = nextSegmentStart - segmentStart;
            chars.splice(segmentStart, removeLen);
            limit -= removeLen;
            i = segmentStart;
        } else if (i === segmentStart + 2 &&
                   chars[segmentStart] === '.' &&
                   chars[segmentStart + 1] === '.') {
            // Remove "prevSegment/../"
            // Find previous segment start
            var searchFrom = segmentStart - 2;
            var prevSlash = -1;
            for (var j = searchFrom; j >= pathStart; j--) {
                if (chars[j] === '/') {
                    prevSlash = j;
                    break;
                }
            }
            var prevSegmentStart = prevSlash + 1;
            var removeFrom = (prevSegmentStart > pathStart) ? prevSegmentStart : pathStart;
            removeLen = nextSegmentStart - removeFrom;
            chars.splice(removeFrom, removeLen);
            limit -= removeLen;
            segmentStart = prevSegmentStart;
            i = prevSegmentStart;
        } else {
            i++;
            segmentStart = i;
        }
    }

    return chars.join('');
}

function urljoin(baseUri, referenceUri) {
    // Map null onto empty string
    baseUri = baseUri || '';
    referenceUri = referenceUri || '';

    var ref = _parseUri(referenceUri);

    // Case 1: Reference has a scheme → it's absolute, use as-is
    if (ref.schemeColon !== -1) {
        var result = referenceUri;
        return _removeDotSegments(result, ref.path, ref.query);
    }

    var base = _parseUri(baseUri);

    // Case 2: Reference is empty or just a fragment
    // → base (without its fragment) + reference
    if (ref.fragment === 0) {
        return baseUri.substring(0, base.fragment) + referenceUri;
    }

    // Case 3: Reference starts with query (but no path)
    // → base (up to but excluding query) + reference
    if (ref.query === 0) {
        return baseUri.substring(0, base.query) + referenceUri;
    }

    // Case 4: Reference has authority (e.g. "//cdn.com/x")
    // → base scheme + reference
    if (ref.path !== 0) {
        var baseLimit4 = base.schemeColon + 1;
        var uri4 = baseUri.substring(0, baseLimit4) + referenceUri;
        return _removeDotSegments(uri4, baseLimit4 + ref.path, baseLimit4 + ref.query);
    }

    // Case 5: Reference path is rooted (starts with '/')
    // → base scheme + authority + reference
    if (referenceUri.charAt(ref.path) === '/') {
        var uri5 = baseUri.substring(0, base.path) + referenceUri;
        return _removeDotSegments(uri5, base.path, base.path + ref.query);
    }

    // Case 6: Relative path — merge with base path
    // Sub-case 6a: Base has authority but empty path → add '/' before reference
    if (base.schemeColon + 2 < base.path && base.path === base.query) {
        var uri6a = baseUri.substring(0, base.path) + '/' + referenceUri;
        return _removeDotSegments(uri6a, base.path, base.path + ref.query + 1);
    }

    // Sub-case 6b: Find last '/' in base path, append reference after it
    var lastSlash = baseUri.lastIndexOf('/', base.query - 1);
    var baseLimit6b = (lastSlash === -1) ? base.path : lastSlash + 1;
    var uri6b = baseUri.substring(0, baseLimit6b) + referenceUri;
    return _removeDotSegments(uri6b, base.path, baseLimit6b + ref.query);
}

function urlJoin() {
    var segments = [];
    for (var i = 0; i < arguments.length; i++) {
        var s = arguments[i];
        if (s === undefined || s === null) continue;
        s = String(s).trim();
        if (s !== '') segments.push(s);
    }
    if (segments.length === 0) return '';

    var result = segments[0];
    for (var i = 1; i < segments.length; i++) {
        var seg = segments[i];

        // If segment has a scheme (absolute URI), it replaces everything
        var segParsed = _parseUri(seg);
        if (segParsed.schemeColon !== -1) {
            result = _removeDotSegments(seg, segParsed.path, segParsed.query);
            continue;
        }

        // For path-join semantics, strip leading '/' from the segment so it's
        // treated as a relative path (not a rooted path that replaces the base).
        // Exception: keep "//" prefix (protocol-relative URL).
        if (seg.startsWith('//')) {
            // Protocol-relative: use as-is
        } else {
            // Strip leading slashes for path-join semantics
            seg = seg.replace(/^\/+/, '');
        }

        // Ensure result ends with '/' so the next segment is a child path
        if (!result.endsWith('/')) result += '/';

        result = urljoin(result, seg);
    }
    return result;
}

export { urljoin, urlJoin };
export default urljoin;
