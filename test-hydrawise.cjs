const fs = require('fs');
const https = require('https');

async function test() {
  console.log("Reading config...");
  const config = JSON.parse(fs.readFileSync('/var/lib/homebridge/config.json', 'utf8'));
  const apiKey = config.platforms.find(p => p.platform === 'Hydrawise').apiKey;
  const controllerId = "335040";

  const url = `https://api.hydrawise.com/api/v1/statusschedule.php?api_key=${apiKey}&controller_id=${controllerId}`;
  console.log(`Fetching ${url.replace(apiKey, 'REDACTED')}`);
  
  https.get(url, (res) => {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
      const status = JSON.parse(data);
      console.log(JSON.stringify(status.relays.map(r => ({ name: r.name, time: r.time, run: r.run })), null, 2));
    });
  });
}
test();
