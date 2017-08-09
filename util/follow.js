require('promise_util');
const http = require('http');
const https = require('https');
const ocsp = require('ocsp');
const URL = require('./url');
const Constants = require('../Constants');
const checkURL = require('./checkURL');
const bodyRedirect = require('./body_redirect');
const hsts = require('./hsts');
const log = require('./logger');

const cache = {
  get(key) {
    const i = this[key];
    if (!i || i && Date.now() - i.time > 172800000) return null;
    return i.data;
  },
  set(name, data) { this[name] = { data, time: Date.now() }; },
};

async function follow(link, handler, noscan = false) {
  link = link
    // Fuck discord
    .replace(/(https?):\/([^/])/, (_, protocol, x) => `${protocol}://${x}`)
    // Fuck people who don't understand that `<url>` means just put the url
    .replace(/(^<|>$)/g, '');

  if (!/https?:\/\//.test(link)) {
    const preloaded = await hsts(link.split(/[/?]/)[0]);
    link = `http${preloaded ? 's' : ''}://${link}`;
  }

  const cache_key = link + noscan;
  const cached = cache.get(cache_key);
  if (cached) return cached;

  const ret = {
    chain: [],
    get safe() {
      return !ret.chain.some((t) => !t.safe);
    },
  };

  const handle = (o) => {
    if (handler) handler(o);
    ret.chain.push(o);
  };

  const promise = Promise.create();
  promise.then(() => {
    log('SCAN', link, `safe=${ret.safe}`);
    cache.set(cache_key, ret);
  });

  (function redirects(url) {
    const options = URL.parse(url);
    options.headers = { 'User-Agent': Constants.UA };
    if (url.startsWith('https')) options.agent = new ocsp.Agent();
    const request = (url.startsWith('https') ? https : http).get(options);
    const x = async(res) => {
      const error = res instanceof Error ? res : null;
      const reasons = noscan === true ? [] : await checkURL(url, error);
      handle({
        url, reasons,
        safe: reasons.length === 0,
      });
      if (error) {
        promise.resolve(ret);
        return;
      }
      if ([300, 301, 302, 303].includes(res.statusCode)) {
        const newURL = /^https?:\/\//i.test(res.headers.location) ?
          res.headers.location :
          URL.resolve(url, res.headers.location);
        redirects(newURL);
      } else {
        let done = false;
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        const finish = () => {
          done = true;
          promise.resolve(ret);
        };
        const timeout = setTimeout(finish, 750);
        res.on('end', () => {
          if (done) return;
          done = true;
          clearTimeout(timeout);
          bodyRedirect(Buffer.concat(chunks).toString(), 750)
            .then(redirects)
            .catch(finish);
        });
      }
    };
    request.once('error', x);
    request.once('response', x);
  }(link));
  return promise;
}

module.exports = follow;
