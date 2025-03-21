# Homebridge SleepMe Basic

A Homebridge plugin that provides Apple HomeKit integration for SleepMe devices (ChiliPad, OOLER, Dock Pro), allowing you to control temperature and mode directly from the Home app or via Siri.

<p align="center">
<img src="https://github.com/homebridge/branding/raw/master/logos/homebridge-color-round-stylized.png" width="150">
</p>

## Features

- **HomeKit Thermostat Control**: Manage your SleepMe device as a standard HomeKit thermostat
- **Temperature Control**: Set and monitor your bed temperature precisely
- **Auto/Off Modes**: Toggle your device on and off easily
- **Model Auto-Detection**: Automatically identifies ChiliPad, OOLER, or Dock Pro models
- **Water Level Monitoring**: View water level status right in HomeKit
- **Temperature Scheduling**: Set schedules for automatic temperature changes throughout the day/week
- **Warm Hug Feature**: Gradually warm your bed before scheduled times for maximum comfort
- **Robust API Integration**: Communicates directly with SleepMe's developer API

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
      "enableScheduling": true,
      "schedules": [
        {
          "time": "22:30",
          "temperature": 30,
          "dayType": "everyday",
          "warmHug": true,
          "warmHugDuration": "20"
        },
        {
          "time": "06:30",
          "temperature": 18,
          "dayType": "weekday",
          "warmHug": false
        }
      ],
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
| `pollingInterval` | number | 120 | How often to check device status (in seconds) |
| `enableScheduling` | boolean | false | Enable temperature scheduling feature |
| `devices` | array | [] | Optional: Customize names for specific devices |

### Scheduling Options

If `enableScheduling` is set to `true`, you can define schedules with these properties:

| Option | Type | Description |
|--------|------|-------------|
| `time` | string | Time in 24-hour format (HH:MM) |
| `temperature` | number | Target temperature (in Celsius) |
| `dayType` | string | "everyday", "weekday", "weekend", or "specific" |
| `specificDay` | string | Day number when `dayType` is "specific" (0-6, 0=Sunday) |
| `warmHug` | boolean | Enable gradual warming before scheduled time |
| `warmHugDuration` | string | Duration in minutes for gradual warming (10-60) |

## Obtaining an API Token

To use this plugin, you need an API token from SleepMe:

1. Visit [developer.sleep.me](https://developer.sleep.me)
2. Or contact SleepMe customer support to request API access
3. Once you have your token, add it to the plugin configuration

## How It Works

This plugin creates a HomeKit thermostat accessory for each of your SleepMe devices. The thermostat interface allows you to:

- **View current temperature** of your SleepMe device
- **Set target temperature** by adjusting the thermostat
- **Turn on/off** via the thermostat power controls (AUTO/OFF modes)
- **Monitor heating/cooling status** as your device works to reach the target temperature

If water level monitoring is supported by your device, this information will be provided through a "battery" service that shows water level percentage and low water warnings.

The scheduler feature enables automatic temperature changes based on the time of day. The "Warm Hug" feature gradually increases the temperature to create a warm wake up 'hug' experience which may function like an alarm to rouse you gently.

## Troubleshooting

### Enabling Debug Mode

If you're having issues, enable debug mode in the plugin configuration. This will provide detailed logs to help diagnose problems:

```json
"debugMode": true,
"verboseLogging": true
```

### Common Issues

1. **Authentication Error**: Check that your API token is correct and still valid.
2. **No Devices Found**: Ensure your SleepMe device is online and properly set up in the SleepMe app.
3. **Connection Issues**: Check your network connection and ensure your Homebridge server can connect to the internet.
4. **API Rate Limiting**: The plugin includes protection against excessive API requests, but if you experience rate limiting, try increasing the `pollingInterval` value.

### Log Analysis

The plugin produces detailed logs when debug mode is enabled. Key log sections include:

- `[PLATFORM]` - Platform initialization and device discovery
- `[API]` - API communication with SleepMe servers
- `[ACCESSORY]` - Thermostat accessory setup and state management
- `[HOMEKIT]` - HomeKit characteristic interactions
- `[SCHEDULER]` - Schedule and Warm Hug functionality

## Development

### Building

```bash
npm run build
```

### Linting

```bash
npm run lint
```

### Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Disclaimer

This plugin is not officially associated with SleepMe (makers of ChiliPad, OOLER, and Dock Pro). Use at your own risk.

## Compatibility

- Requires Homebridge v1.8.0 or later
- Tested with Node v18+
- Compatible with all SleepMe devices that support the developer API