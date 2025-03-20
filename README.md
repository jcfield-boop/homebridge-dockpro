# Homebridge SleepMe Basic

A Homebridge plugin for controlling SleepMe devices (ChiliPad, OOLER, Dock Pro) through Apple HomeKit. This plugin provides basic thermostat functionality, allowing you to control your SleepMe device's temperature and operating mode directly from the Home app on your iOS devices or via Siri.

<p align="center">
<img src="https://github.com/homebridge/branding/raw/master/logos/homebridge-color-round-stylized.png" width="150">
</p>

## Features

- Control your SleepMe device as a HomeKit thermostat
- View current water temperature
- Set target temperature
- Control heating/cooling modes
- Customize device names
- Comprehensive logging for troubleshooting

## Installation

You can install this plugin through the Homebridge UI or manually using npm:

```bash
npm install -g homebridge-sleepme-basic
```

## Configuration

Configuration can be done through the Homebridge UI or by manually editing your Homebridge `config.json` file.

### Required Configuration

- **API Token**: You need to obtain an API token from SleepMe to use this plugin. Visit [developer.sleep.me](https://developer.sleep.me) or contact SleepMe support to get access.

### Example Configuration

```json
{
  "platforms": [
    {
      "platform": "SleepMeBasic",
      "name": "SleepMe Basic",
      "apiToken": "YOUR_API_TOKEN_HERE",
      "unit": "C",
      "debugMode": false,
      "pollingInterval": 60,
      "devices": [
        {
          "id": "zx-YOUR_DEVICE_ID",
          "name": "Bedroom Chiller"
        }
      ]
    }
  ]
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `platform` | string | Required | Must be "SleepMeBasic" |
| `name` | string | "SleepMe Basic" | Name to display in Homebridge |
| `apiToken` | string | Required | Your SleepMe API token |
| `unit` | string | "C" | Temperature unit ("C" for Celsius, "F" for Fahrenheit) |
| `debugMode` | boolean | false | Enable detailed logging for troubleshooting |
| `pollingInterval` | number | 60 | How often to check device status (in seconds) |
| `devices` | array | [] | Optional: Customize names for specific devices |

## Obtaining an API Token

To use this plugin, you need an API token from SleepMe:

1. Visit [developer.sleep.me](https://developer.sleep.me) (if available)
2. Or contact SleepMe customer support to request API access
3. Once you have your token, add it to the plugin configuration

## Troubleshooting

### Enabling Debug Mode

If you're having issues, enable debug mode in the plugin configuration. This will provide detailed logs to help diagnose problems:

```json
"debugMode": true
```

### Common Issues

1. **Authentication Error**: Check that your API token is correct and still valid.
2. **No Devices Found**: Ensure your SleepMe device is online and properly set up in the SleepMe app.
3. **Connection Issues**: Check your network connection and ensure your Homebridge server can connect to the internet.

### Log Analysis

The plugin produces detailed logs when debug mode is enabled. Key log sections include:

- `[PLATFORM]` - Platform initialization and device discovery
- `[API]` - API communication with SleepMe servers
- `[ACCESSORY]` - Thermostat accessory setup and state management
- `[HOMEKIT]` - HomeKit characteristic interactions

## Development

### Building

```bash
npm run build
```

### Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Disclaimer

This plugin is not officially associated with SleepMe. Use at your own risk.

## Roadmap

Future plans for this plugin include:

- Humidity sensor support
- Temperature scheduling
- Warm awake feature
- Historical data tracking