import * as vscode from 'vscode';
import { ChatLogger } from './chatLogger';
import { VirtualDocumentMonitor } from './virtualDocumentMonitor';

let chatLogger: ChatLogger;
let virtualDocumentMonitor: VirtualDocumentMonitor;

export function activate(context: vscode.ExtensionContext) {
    console.log('ChatLogger activated!');
    
    // Initialize the chat logger
    chatLogger = new ChatLogger(context);
    
    // Initialize the virtual document monitor
    virtualDocumentMonitor = new VirtualDocumentMonitor(chatLogger);
    virtualDocumentMonitor.start();
    
    // Log activation
    chatLogger.outputChannel.appendLine('ChatLogger extension activated successfully!');
    chatLogger.outputChannel.appendLine('VirtualDocumentMonitor started - monitoring Cursor conversations...');
    
    // Register commands
    const saveConversationCommand = vscode.commands.registerCommand('chatlogger.saveConversation', async () => {
        try {
            await chatLogger.saveCurrentConversation();
            vscode.window.showInformationMessage('Conversation saved successfully!');
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to save conversation: ${error}`);
        }
    });
    
    const viewHistoryCommand = vscode.commands.registerCommand('chatlogger.viewHistory', async () => {
        try {
            await chatLogger.showHistoryView();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to view history: ${error}`);
        }
    });
    
    const clearHistoryCommand = vscode.commands.registerCommand('chatlogger.clearHistory', async () => {
        const result = await vscode.window.showWarningMessage(
            'Are you sure you want to clear all chat history? This action cannot be undone.',
            { modal: true },
            'Yes, Clear All'
        );
        
        if (result === 'Yes, Clear All') {
            try {
                await chatLogger.clearHistory();
                vscode.window.showInformationMessage('Chat history cleared successfully!');
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to clear history: ${error}`);
            }
        }
    });

    // Command to list all open virtual documents
    const listVirtualDocsCommand = vscode.commands.registerCommand('chatlogger.listVirtualDocs', () => {
        const docs = vscode.workspace.textDocuments;
        let found = false;
        chatLogger.outputChannel.appendLine('--- Open Virtual Documents ---');
        for (const doc of docs) {
            if (doc.uri.scheme !== 'file') {
                found = true;
                chatLogger.outputChannel.appendLine(`Virtual doc: ${doc.uri.toString()} (scheme: ${doc.uri.scheme})`);
            }
        }
        if (!found) {
            chatLogger.outputChannel.appendLine('No open virtual documents found.');
        }
        chatLogger.outputChannel.show();
    });
    
    // Command to manually trigger conversation check
    const checkConversationsCommand = vscode.commands.registerCommand('chatlogger.checkConversations', async () => {
        if (virtualDocumentMonitor) {
            chatLogger.outputChannel.appendLine('Manually triggering conversation check...');
            await virtualDocumentMonitor['checkForChanges']('manual');
            chatLogger.outputChannel.show();
        } else {
            vscode.window.showErrorMessage('VirtualDocumentMonitor not initialized');
        }
    });
    
    // Add commands to context subscriptions
    context.subscriptions.push(saveConversationCommand);
    context.subscriptions.push(viewHistoryCommand);
    context.subscriptions.push(clearHistoryCommand);
    context.subscriptions.push(listVirtualDocsCommand);
    context.subscriptions.push(checkConversationsCommand);
    
    // Update configuration when it changes
    const configChangeListener = vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('chatlogger')) {
            chatLogger.updateConfiguration();
            virtualDocumentMonitor.updateConfiguration();
        }
    });
    
    context.subscriptions.push(configChangeListener);
}

export function deactivate() {
    console.log('ChatLogger extension is now deactivated!');
    if (virtualDocumentMonitor) {
        virtualDocumentMonitor.dispose();
    }
} 