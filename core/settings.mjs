export default class settings {
  constructor(homeeID) {
    this.homee_name = '';
    this.city = '';
    this.latitude = '';
    this.longitude = '';
    this.country_code = 'DE';
    this.language = 'de';
    this.remote_access =1;
    this.beta= 0;
    this.webhooks_key ='WEBHOOKKEY';
    this.automatic_location_detection = 0;
    this.polling_interval = 60;
    this.timezone = 'Europe%2FBerlin';
    this.enable_analytics = 0;
    this.wlan_enabled=1;
    this.wlan_ip_address = '192.168.178.222';
    this.wlan_ssid = 'homeeWifi';
    this.wlan_mode = 2;
    this.available_ssids = ['homeeWifi'];
    this.time = 1769895986;
    this.internet_access = true;
    this.local_ssl_enable =true;
    this.civil_time = '2026-01-31 22:46:26';
    this.version = '2.41.3+46ad073c';
    this.uid = '000551183EAB';
    this.cubes = [];
    this.extensions= {
        "weather": {
            "enabled": 1
        },
        "amazon_alexa": {
            "enabled": 0
        },
        "google_assistant": {
            "enabled": 0,
            "syncing": 0
        },
        "apple_homekit": {
            "enabled": 0,
            "syncing": 0
        },
        "matter_bridge": {
            "enabled": "0"
        },
        "ftp": {
            "enabled": 0
        },
        "history": {
            "enabled": 0
        },
        "backup": {
            "enabled": 0
        },
        "proxy": {
            "enabled": 0,
            "connected": true,
            "environment": 0
        },
        "electricity_price": {
            "enabled": 0
        },
        "ssh_tunnel": {
            "enabled": false
        },
        "notification": {
            "email_daily_count": 0,
            "email_daily_limit": 50,
            "email_monthly_count": 0,
            "email_monthly_limit": 1550,
            "email_next_daily_reset_date": 1769900400,
            "email_next_monthly_reset_date": 1769900400,
            "environment": 1
        },
        "dropbox": {
            "enabled": false
        },
        "watchdog": {
            "enabled": true,
            "run_period": 10000
        },
        "mosquitto_mqtt": {},
        "asteria_db": {
            "enabled": 1
        }
    };
  }
}
