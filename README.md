# ChatLogger

A VS Code extension that automatically records Cursor chat conversations with timestamps, while intelligently filtering out assistant code output for cleaner logs.

## Features

- **🔄 Automatic Recording**: Automatically saves chat conversations as they happen
- **⏰ Timestamp Tracking**: Records precise timestamps for each message
- **🧹 Smart Filtering**: Optionally ignores assistant code output for cleaner logs
- **📊 Conversation History**: View and manage your chat history within VS Code
- **⚙️ Configurable**: Customize behavior through VS Code settings
- **🔍 Real-time Monitoring**: Continuously monitors for new conversations
- **🤫 Silent Operation**: Runs completely in the background without user commands

## Installation

### From VSIX
1. Download the latest `.vsix` file from the releases
2. In VS Code, go to Extensions (Ctrl+Shift+X)
3. Click the "..." menu and select "Install from VSIX..."
4. Choose the downloaded file

### From Source
```bash
git clone https://github.com/dassio/chatlogger.git
cd chatlogger
npm install
npm run build
npm run package
```

## Usage

### Automatic Operation

Once installed, ChatLogger automatically:
1. Monitors for new Cursor chat conversations
2. Saves them to the `.chatlogger` directory in your workspace
3. Updates the Chat History view in the Explorer panel

### Viewing Conversations

1. Open the Explorer panel (Ctrl+Shift+E)
2. Look for the "Chat History" section (when auto-save is enabled)
3. Click on any conversation to view its details

**Note**: The extension operates completely automatically. All conversations are saved to the `.chatlogger` directory in your workspace without any manual intervention required.

## Configuration

Configure ChatLogger through VS Code settings (Ctrl+,):

### Auto Save
- **`chatlogger.autoSave.enabled`** (default: `true`)
  - Automatically save chat conversations to the `.chatlogger` directory

### Code Output Filtering
- **`chatlogger.ignoreCodeOutput`** (default: `true`)
  - Ignore assistant code output in recorded conversations for cleaner logs

### Output Format
- **`chatlogger.outputFormat`** (default: `markdown`)
  - Choose from: `markdown`, `json`, `txt`

### Timestamp Format
- **`chatlogger.timestampFormat`** (default: `ISO`)
  - Choose from: `ISO`, `local`, `relative`

### Check Interval
- **`chatlogger.checkInterval`** (default: `30000`)
  - Interval in milliseconds to check for new conversations (5-300 seconds)

## File Structure

Conversations are saved in the following structure:
```
./
├── .chatlogger/
│   └── conversations/
│       ├── 2024-01-15T10-30-00-000Z_composer123.json
│       ├── 2024-01-15T14-45-00-000Z_composer456.json
│       └── ...
```

Each conversation file contains:
- Message history with timestamps
- User and assistant roles
- Metadata (workspace path, file context, etc.)
- Filtered content (if code output filtering is enabled)

## Conversation Format

### JSON Structure
```json
{
  "id": "conversation-id",
  "title": "Conversation Title",
  "createdAt": "2024-01-15 10:30:00",
  "updatedAt": "2024-01-15 14:45:00",
  "messages": [
    {
      "id": "message-id",
      "timestamp": "2024-01-15 10:30:00",
      "role": "user",
      "content": "How do I implement a binary search?",
      "filteredContent": "How do I implement a binary search?",
      "metadata": {
        "hasCodeBlocks": false,
        "messageLength": 35,
        "isFiltered": false
      }
    }
  ],
  "metadata": {
    "workspacePath": "/path/to/workspace",
    "totalMessages": 10,
    "userMessages": 5,
    "assistantMessages": 5
  }
}
```

## Troubleshooting

### No Conversations Appearing
1. Check if auto-save is enabled in settings
2. Verify Cursor is running and has active conversations
3. Check the ChatLogger output channel for error messages
4. Ensure the extension is activated (should happen automatically on startup)

### Missing Messages
1. Ensure the check interval is appropriate for your usage
2. Check if code output filtering is removing desired content
3. Verify the conversation is still active in Cursor

### Performance Issues
1. Increase the check interval to reduce CPU usage
2. Clear old conversation history if storage becomes large
3. Disable auto-save in settings if needed

## Development

### Building from Source
```bash
npm install
npm run build
npm run watch  # For development with auto-rebuild
```

### Testing
1. Press F5 in VS Code to launch extension development host
2. Test commands and functionality
3. Check the output channel for debug information

### Packaging
```bash
npm run package
```

## Contributing

1. Fork the repository on GitHub
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## Support

- **Issues**: Report bugs and request features on GitHub
- **Discussions**: Ask questions and share ideas
- **Documentation**: Check the code comments for implementation details

## Changelog

### v0.1.0
- Initial release
- Automatic conversation recording
- Multiple output formats
- Configurable settings
- Conversation history viewer
- Code output filtering
- Silent background operation (no manual commands)

---

**Note**: This extension is designed specifically for Cursor chat conversations. It may not work with other chat interfaces in VS Code. 