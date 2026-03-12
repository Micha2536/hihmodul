// HueApi.mjs
import https from 'https';

class HueApi {
  constructor(hue_ip, options ,config) {
    this.hue_ip = hue_ip;
    this.options = options;
    this.config = config;
  }

  async getLights() {
    try {
      const data = await new Promise((resolve, reject) => {
        const request = https.request(`https://${this.hue_ip}/clip/v2/resource/light`, this.options, (response) => {
          let data = '';
          response.on('data', (chunk) => {
            data += chunk;
          });

          response.on('end', () => {
            resolve(data);
          });

          response.on('error', (error) => {
            reject(error);
          });
        });

        request.end();
      });

      return JSON.parse(data).data;
    } catch (error) {
      console.error(`HTTPS request error: ${error}`);
      return null;
    }
  };
  async getDevice() {
    try {
      const data = await new Promise((resolve, reject) => {
        const request = https.request(`https://${this.hue_ip}/clip/v2/resource/device`, this.options, (response) => {
          let data = '';
          response.on('data', (chunk) => {
            data += chunk;
          });

          response.on('end', () => {
            resolve(data);
          });

          response.on('error', (error) => {
            reject(error);
          });
        });

        request.end();
      });

      return JSON.parse(data).data;
    } catch (error) {
      console.error(`HTTPS request error: ${error}`);
      return null;
    }
  };
  async getRoom() {
    try {
      const data = await new Promise((resolve, reject) => {
        const request = https.request(`https://${this.hue_ip}/clip/v2/resource/room`, this.options, (response) => {
          let data = '';
          response.on('data', (chunk) => {
            data += chunk;
          });

          response.on('end', () => {
            resolve(data);
          });

          response.on('error', (error) => {
            reject(error);
          });
        });

        request.end();
      });

      return JSON.parse(data).data;
    } catch (error) {
      console.error(`HTTPS request error: ${error}`);
      return null;
    }
  };
  async getZone() {
    try {
      const data = await new Promise((resolve, reject) => {
        const request = https.request(`https://${this.hue_ip}/clip/v2/resource/zone`, this.options, (response) => {
          let data = '';
          response.on('data', (chunk) => {
            data += chunk;
          });

          response.on('end', () => {
            resolve(data);
          });

          response.on('error', (error) => {
            reject(error);
          });
        });

        request.end();
      });

      return JSON.parse(data).data;
    } catch (error) {
      console.error(`HTTPS request error: ${error}`);
      return null;
    }
  };
  async getPower() {
    try {
      const data = await new Promise((resolve, reject) => {
        const request = https.request(`https://${this.hue_ip}/clip/v2/resource/device_power`, this.options, (response) => {
          let data = '';
          response.on('data', (chunk) => {
            data += chunk;
          });

          response.on('end', () => {
            resolve(data);
          });

          response.on('error', (error) => {
            reject(error);
          });
        });

        request.end();
      });

      return JSON.parse(data).data;
    } catch (error) {
      console.error(`HTTPS request error: ${error}`);
      return null;
    }
  };
  async getLightLevel() {
    try {
      const data = await new Promise((resolve, reject) => {
        const request = https.request(`https://${this.hue_ip}/clip/v2/resource/light_level`, this.options, (response) => {
          let data = '';
          response.on('data', (chunk) => {
            data += chunk;
          });

          response.on('end', () => {
            resolve(data);
          });

          response.on('error', (error) => {
            reject(error);
          });
        });

        request.end();
      });

      return JSON.parse(data).data;
    } catch (error) {
      console.error(`HTTPS request error: ${error}`);
      return null;
    }
  };
  async getTemperature() {
    try {
      const data = await new Promise((resolve, reject) => {
        const request = https.request(`https://${this.hue_ip}/clip/v2/resource/temperature`, this.options, (response) => {
          let data = '';
          response.on('data', (chunk) => {
            data += chunk;
          });

          response.on('end', () => {
            resolve(data);
          });

          response.on('error', (error) => {
            reject(error);
          });
        });

        request.end();
      });

      return JSON.parse(data).data;
    } catch (error) {
      console.error(`HTTPS request error: ${error}`);
      return null;
    }
  };
  async getZigbee() {
    try {
      const data = await new Promise((resolve, reject) => {
        const request = https.request(`https://${this.hue_ip}/clip/v2/resource/zigbee_connectivity`, this.options, (response) => {
          let data = '';
          response.on('data', (chunk) => {
            data += chunk;
          });

          response.on('end', () => {
            resolve(data);
          });

          response.on('error', (error) => {
            reject(error);
          });
        });

        request.end();
      });

      return JSON.parse(data).data;
    } catch (error) {
      console.error(`HTTPS request error: ${error}`);
      return null;
    }
  };
  async putDeviceOn(state, id, node_id) {
    const options = {
      method: 'PUT',
      headers: {
        'hue-application-key': this.config.key
      },
      rejectUnauthorized: false
    };

    const c = node_id.find(d => d.id === id);

    if (!c) {
      throw new Error(`No node found with id ${id}`);
    }

    const data = JSON.stringify({
      on: {
        on: state
      }
    });

    return new Promise((resolve, reject) => {
      const request = https.request(`https://${this.hue_ip}/clip/v2/resource/${c.type}/${c.id_v1}`, options, (response) => {
        let responseData = '';

        response.on('data', (chunk) => {
          responseData += chunk;
        });

        response.on('end', () => {
          resolve(responseData);
        });

        response.on('error', (error) => {
          reject(error);
        });
      });

      request.on('error', (error) => {
        reject(error);
      });

      request.write(data);
      request.end();
    });
  }
}


export default HueApi;
