const fs = require('fs');
const https = require('https');

async function test() {
  const config = JSON.parse(fs.readFileSync('/var/lib/homebridge/config.json', 'utf8'));
  const apiKey = config.platforms.find(p => p.platform === 'Hydrawise').apiKey;
  const controllerId = "335040";

  const url = `https://api.hydrawise.com/api/v1/statusschedule.php?api_key=${apiKey}&controller_id=${controllerId}`;
  
  https.get(url, (res) => {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
      const status = JSON.parse(data);
      console.log(JSON.stringify(status.relays.map(r => ({ name: r.name, relay_id: r.relay_id })), null, 2));
    });
  });
}
test();
