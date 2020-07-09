# Token registry Discord bot

Watch the [Obyte decentralized registry](https://tokens.ooo) Autonomous Agent and post a notification on Discord when something happens.

**Important:** works only with NodeJS version 11.

## Setup

- `npm install`
- Run with `node start.js`, it will create an app data directory in `~/.conf/token-registry-discord-bot` then fail due to configuration missing
- While logged on Discord webapp, create an application at https://discord.com/developers/applications 
- Select the application, select bot in menu, copy the bot token
- Create a conf.json file as below and save it in `~/.conf/token-registry-discord-bot` 
	```json
	{
		"discord_channels": ["729547841801814157"],
		"discord_token" : "NzI5MTS4MzAzOTUzNDczNjY3.Xwehjw.e1fXVqVJo1qNSkgfSE7lgixg2nE"
	}
	```
`discord_channels` is an array containing the channel IDs on which the bot should post notifications and `discord_token` the token you have copied.
- While logged on Discord, use the following url template to add the bot to your server: https://discord.com/oauth2/authorize?client_id=729169303953473667&scope=bot&permissions=2048, `client_id` can be found in the General Information of your Discord application, permissions should be `2048` to allow only posting message.
- Run the bot with `node start.js`