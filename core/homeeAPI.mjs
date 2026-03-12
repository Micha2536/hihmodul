// create EventEmitter object
import EventEmitter from 'events';

import WebSocket, { WebSocketServer } from 'ws';
import http from 'http';
import url from 'url';
import express from 'express';
import bodyParser from 'body-parser';
import discovery from './discovery.cjs';
import Settings from './settings.mjs';

const debugEnabled = process.env.DEBUG_HOMEEAPI === '1';
const dbg = (...args) => { if (debugEnabled) console.log('[homeeAPI]', ...args); };

/**
 * class that handles the homee api
 */
export default class HomeeAPI extends EventEmitter {
  constructor(homeeID) {
    dbg('init', { homeeID });
    super();
    this.homeeID = homeeID;
    this.wss = new WebSocketServer({ noServer: true });
    dbg('WebSocketServer created (noServer)');
    this.app = express();
    this.app.use(bodyParser.json());
    this.app.use(bodyParser.urlencoded({extended: false}));
    this.server = http.createServer(this.app);
    this.AccessToken = 'SUPERSECUREACCESSTOKENTHISNEEDSTOBECHANGEDATSOMEPOINT';
  }
  /** test events */
  testEvent() {
    this.emit('test', 'some test data');
  }

  send(message) {
    this.wss.clients.forEach( function each(client) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }
  start() {
    dbg('starting discovery', this.homeeID);
    discovery.start(this.homeeID);

    this.server.listen(7681, '0.0.0.0');
    this.server.on('error', function(err) {
      console.log('homee Api Server caused an error: ' + err);
      console.log('cannot run without api server, exiting');
      process.exit(1);
    });

    this.server.on('upgrade', this.OnHttpServerUpgrade.bind(this) );
    this.wss.on('connection', (ws) => {
      this.ws = ws;
      ws.on('message', (message, isBinary) => {
        this.onWSMessage(message, isBinary, ws);
      });
});
    this.app.options('/access_token', this.OnExpressOptionAccessToken.bind(this) );
    this.app.post('/access_token', this.OnExpressPostAccessToken.bind(this) );
  }

  setNodes(nodes) {
    this.nodes = nodes;
  }

  onWSMessage(message, isBinary, ws) {
    const msg = normalizeWsMessage(message, isBinary);
    if (msg !== 'ping') {
      dbg('ws recv', msg);
    }
    const parsed = parse(msg);
//console.log('parsed data: %o', parsed);
    this.emit(parsed.method, parsed);
    if ( parsed.method === 'ping') {
      ws.send('pong');
    }
    if ( iequals(parsed.method, 'get') ) {
      if (iequals( parsed.target, 'nodes')) {
        if ( parsed.commands['nodes'] == 0 ) {
          this.emit('GET:nodes', []);
          ws.send(JSON.stringify({'nodes': this.nodes}));
        } else {
          this.emit('GET:nodes', parsed.commands['nodes']);
        }
      }
      if ( parsed.target === 'all') {
        this.emit('GET:all', []);
        ws.send(JSON.stringify( {'all':
        {
          'nodes': this.nodes,
          'users': [
            {
              'id': 1,
              'username': 'homee',
              'forename': 'homee',
              'surname': 'homee',
              'image': '',
              'role': 2,
              'type': 1,
              'email': '',
              'phone': '',
              'added': '27. Jan 2016 13:37:00 (1453898220)',
              'homee_name': '🏠',
              'homee_image': 'profileicon_5_1',
              'access': 1,
              'cube_push_notifications': 1,
              'cube_email_notifications': 0,
              'cube_sms_notifications': 0,
              'node_push_notifications': 1,
              'node_email_notifications': 0,
              'node_sms_notifications': 0,
              'warning_push_notifications': 1,
              'warning_email_notifications': 0,
              'warning_sms_notifications': 0,
              'update_push_notifications': 1,
              'update_email_notifications': 0,
              'update_sms_notifications': 0,
              'api_push_notifications': 0,
              'api_email_notifications': 0,
              'api_sms_notifications': 0}],
          'groups': [],
          'relationships': [],
          'homeegrams': [],
          'settings': new Settings(this.homeeID),
          'plans': [],
        },
        } ));
      }
      if ( parsed.target === 'settings') {
        this.emit('GET:settings', []);
        ws.send(JSON.stringify( {'settings':
          new Settings(this.homeeID),
        } ));
      }
    }
    if ( parsed.method === 'put' ) {
      if ( parsed.target === 'attributes') {
        if ( parsed.commands['attributes'] === 0) {
          //console.log('ids sind %o', parsed.parameters['ids']);
          parsed.parameters['ids'].split(',').forEach((id) => {
            console.log('id %o', id);
            if (id !== '') {
              this.emit('PUT:attributes',
                  id,
                  parsed.commands['nodes'],
                  parsed.parameters['target_value'],
                  parsed);
            }
          });
        } else {
          this.emit('PUT:attributes',
              parsed.commands['attributes'],
              parsed.commands['nodes'],
              parsed.parameters['target_value'],
              parsed);
        }
      }
    }
    if ( parsed.method === 'post' ) {
      if ( parsed.target === 'nodes') {
        const protocol = parsed.parameters['protocol'];
        const check = parsed.parameters['compatibility_check'];
        const version = parsed.parameters['my_version'];
        const startPairing = parsed.parameters['start_pairing'];
        if ( protocol === '21') {
          if ( check === '1') {
            // just echo back what homee wants to hear
      
            const payload = {
        compatibility_check: {
          compatible: true,
          account: true,
          external_homee_status: "none",
          your_version: true,
          my_version: version.replace(/ /g, '+'),
          my_homeeID: String(this.homeeID),
        },
      };

      // "2.41.3+46ad073c"
            ws.send(JSON.stringify(payload)
              );
          }
          if ( startPairing === '1') {
            // just echo back what homee wants to hear
            ws.send('{' +
              '    "pairing":{' +
              '        "access_token": "' + this.AccessToken + '",' +
              '        "expires": 31536000,' +
              '        "userID": 1,' +
              '        "deviceID": 1' +
              '    }' +
              '}');
          }
        }
      }
    }
    if ( parsed.method === 'delete' ) {
      if ( parsed.target === 'devices') {
        ws.send('{\n' +
          '    "warning": {\n' +
          '        "code": 600,\n' +
          '        "description": "Your device got removed.",\n' +
          '        "message": "You have been logged out.",\n' +
          '        "data": {}\n' +
          '    }\n' +
          '}');
          ws.close(4444, 'DEVICE_DISCONNECT');
      }
    }
  }

  OnHttpServerUpgrade(request, socket, head) {
    const ParsedUrl = url.parse(request.url);
    const pathname = ParsedUrl.pathname;

    if (pathname === '/connection') {
      const params = new URLSearchParams(ParsedUrl.query);
      const GivenAccessToken = params.get('access_token');
      if (GivenAccessToken == this.AccessToken) {
        this.wss.handleUpgrade(request, socket, head, (ws) => {
          this.wss.emit('connection', ws, request);
        });
      } else {
        socket.destroy();
      }
    } else {
      socket.destroy();
    }
  }

  OnExpressOptionAccessToken(req, res) {
    const header = {
      'Access-Control-Allow-Headers': 'Authorization',
      'Access-Control-Allow-Methods': 'POST, DELETE',
      'Access-Control-Allow-Origin': '*',
      'Content-Length': '0',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Server': 'homeejs Server',
    };
    res.writeHead(200, header);
    res.end();
  }

  OnExpressPostAccessToken(req, res) {
    //   console.log('body: %o , header %o', req.body, req.headers);
    const auth = req.headers['authorization']; // auth is in base64(username:password)  so we need to decode the base64
    console.log('Authorization Header is: ', auth);

    if (auth) { // The Authorization was passed in so now we validate it
      const tmp = auth.split(' '); // Split on a space, "Basic Y2hhcmxlczoxMjM0NQ=="

      // eslint-disable-next-line new-cap
      const buf = new Buffer.from(tmp[1], 'base64'); // create a buffer and tell it the data coming in is base64
      const PlainAuth = buf.toString(); // read it back out as a string

      console.log('Decoded Authorization ', PlainAuth);

      // At this point plain_auth = "username:password"

      const creds = PlainAuth.split(':'); // split on a ':'
      const username = creds[0];
      const password = creds[1];

      // eslint-disable-next-line max-len
      // TODO: handle username / password
      if ( username === 'homee' ) { // && password = sha512('12345678')
        // eslint-disable-next-line max-len
        const response = 'access_token=' + this.AccessToken + '&user_id=1&device_id=1&expires=31536000';
        res.writeHead(200, {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Access-Control-Allow-Origin': '*',
          'Server': 'homeejs Server'});
        res.write(response);
        res.end();
      } else {
        res.statusCode = 401; // Force them to retry authentication
        res.writeHead(401, {
          'WWW-Authenticate': 'Basic realm="Secure Area"',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Access-Control-Allow-Origin': '*',
          'Server': 'homeejs Server'});
        const response = ' {"errors":[{"status":"401","detail":"Invalid username or password.","blockTime": 2 }]}';
        res.write(response);
        res.end();
      }
    }
  }
};

/**
 * compares two string, case insensitive
 * @param {*} a
 * @param {*} b
 * @return {bool} true if equal, false otherwise
 */
function iequals(a, b) {
  return typeof a === 'string' && typeof b === 'string'
        ? a.localeCompare(b, undefined, {sensitivity: 'accent'}) === 0
        : a === b;
}


function normalizeWsMessage(data, isBinary) {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) {
    const parts = data.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p)));
    return Buffer.concat(parts).toString('utf8');
  }
  // Fallback for unexpected types
  return String(data);
}

function parse(message) {
  // "put:nodes/1/attributes/1?target_value=1"
  if ( message.indexOf(':') === -1 ) {
    // special commands
    if ( iequals(message, 'ping')) {
      return {method: 'ping', commands: '', target: '', parameters: {}};
    }
  }
  let [method, a] = message.split(':');
  method = method.toLowerCase();
  const [commands, parameters] = a.split('?');
  let c;
  const cmds = {};
  let targetCmd;
  for ( const t of commands.split('/')) {
    if ( isNaN(t) ) {
      c = t.toLowerCase();
      continue;
    }
    cmds[c] = t;
    targetCmd = c.toLowerCase();
    c = '';
  }
  if ( c !== '') {
    targetCmd = c;
    cmds[c.toLowerCase()] = 0;
  }
  if ( !targetCmd ) {
    // in case there are no parameter or anything (like get:nodes)
    targetCmd = commands.toLowerCase();
    cmds[commands.toLowerCase()] = 0;
  }
  const searchParams = new URLSearchParams(parameters);

  const paras = {};
  searchParams.forEach(function(value, key) {
    console.log(value, key);
    paras[key.toLowerCase()] = value;
  });
  console.log(message);
  return {method: method, commands: cmds, target: targetCmd, parameters: paras};
}
