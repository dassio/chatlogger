import * as vscode from 'vscode';
import { ChatLogger } from './chatLogger';
import { ChatConversationMonitor } from './ChatConversationMonitor';

let chatLogger: ChatLogger;
let chatConversationMonitor: ChatConversationMonitor;

export async function activate(context: vscode.ExtensionContext) {
    chatLogger = new ChatLogger(context);

    chatConversationMonitor = new ChatConversationMonitor(chatLogger);
    chatLogger.setMonitor(chatConversationMonitor);
    await chatLogger.loadSavedConversations();
    chatConversationMonitor.start();

    chatLogger.outputChannel.appendLine('ChatLogger extension activated successfully!');

    // Register commands
    const calculateGitConversationCommand = vscode.commands.registerCommand('chatlogger.calculateGitConversation', async () => {
        try {
            await chatLogger.triggerGitBasedCalculation();
            vscode.window.showInformationMessage('Git-based conversation calculation completed successfully!');
        } catch (error) {
            vscode.window.showErrorMessage(`Error calculating git conversation: ${error}`);
        }
    });

    // Update configuration when it changes
    const configChangeListener = vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('chatlogger')) {
            chatLogger.updateConfiguration();
            chatConversationMonitor.updateConfiguration();
        }
    });

    context.subscriptions.push(configChangeListener, calculateGitConversationCommand);
}

export function deactivate() {
    console.log('ChatLogger extension is now deactivated!');
    if (chatConversationMonitor) {
        chatConversationMonitor.dispose();
    }
} 