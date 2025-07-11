import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs-extra';
import { ChatConversationMonitor } from './ChatConversationMonitor';
import { GitConversationTracker } from './gitConversationTracker';

export interface ChatMessage {
    id: string;
    bubbleId?: string;
    timestamp: Date;
    role: 'user' | 'assistant' | 'system';
    content: string;
    filteredContent?: string;
    metadata: {
        hasCodeBlocks: boolean;
        codeLanguage?: string;
        messageLength: number;
        isFiltered: boolean;
    };
}

export interface Conversation {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    title: string;
    messages: ChatMessage[];
    metadata: {
        workspacePath?: string;
        fileContext: string[];
        totalMessages: number;
        userMessages: number;
        assistantMessages: number;
        totalTokensEstimated: number;
        composerId?: string;
        sessionId?: string;
        source?: string;
        filePath?: string;
    };
}

export class ChatLogger {
    private conversations: Map<string, Conversation> = new Map();
    private context: vscode.ExtensionContext;
    public outputChannel: vscode.OutputChannel;
    private config: any;
    private monitor: ChatConversationMonitor | undefined;
    private gitTracker: GitConversationTracker | undefined;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.outputChannel = vscode.window.createOutputChannel('ChatLogger');
        this.loadConfiguration();
        this.initializeGitTracker();
    }

    private loadConfiguration() {
        const config = vscode.workspace.getConfiguration('chatlogger');
        this.config = {
            autoSave: config.get('autoSave.enabled', true),
            ignoreCodeOutput: config.get('ignoreCodeOutput', true),
            outputFormat: config.get('outputFormat', 'markdown'),
            timestampFormat: config.get('timestampFormat', 'ISO'),
            checkInterval: config.get('checkInterval', 30000)
        };
    }

    private initializeGitTracker() {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
            this.gitTracker = new GitConversationTracker(workspaceFolder);
            this.outputChannel.appendLine('Git conversation tracker initialized');
        } else {
            this.outputChannel.appendLine('No workspace folder found, git tracker not initialized');
        }
    }

    public updateConfiguration() {
        this.loadConfiguration();
    }

    public setMonitor(monitor: ChatConversationMonitor) {
        this.monitor = monitor;
    }

    public async saveCurrentConversation(): Promise<void> {
        // This will be called by the virtual document monitor
        // when it detects a conversation that needs to be saved
        const conversation = this.getCurrentConversation();
        if (conversation) {
            await this.saveConversation(conversation);
        }
    }

    private recalculateMetadata(conversation: Conversation): Conversation {
        const messages = conversation.messages || [];
        const userMessages = messages.filter(msg => msg.role === 'user').length;
        const assistantMessages = messages.filter(msg => msg.role === 'assistant').length;
        const totalTokensEstimated = messages.reduce((sum, msg) =>
            sum + Math.ceil((msg.content || '').split(/\s+/).length * 1.3), 0
        );
        return {
            ...conversation,
            metadata: {
                ...conversation.metadata,
                totalMessages: messages.length,
                userMessages,
                assistantMessages,
                totalTokensEstimated,
            }
        };
    }

    public async saveConversation(conversation: Conversation): Promise<void> {
        function toLocalString(date: Date | string): string {
            return new Date(date).toLocaleString();
        }
        try {
            // Get the workspace folder URI
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                throw new Error('No workspace folder found');
            }
            // Build the .chatlogger/conversations directory URI
            const storageUri = vscode.Uri.joinPath(workspaceFolder.uri, '.chatlogger', 'conversations');

            // Ensure the directory exists (create if not)
            try {
                await vscode.workspace.fs.createDirectory(storageUri);
            } catch (e) {
                // Ignore if already exists
            }

            // Use createdAt date and composerId as the file name
            const composerId = conversation.metadata.composerId;
            if (!composerId) {
                throw new Error('Cannot save conversation without composerId');
            }
            const createdAt = conversation.createdAt instanceof Date
                ? conversation.createdAt
                : new Date(conversation.createdAt);
            const isoString = createdAt.toISOString().replace(/[:.]/g, '-');
            const fileName = `${isoString}_${composerId}.json`;
            const fileUri = vscode.Uri.joinPath(storageUri, fileName);

            // Merge with existing conversation if it exists
            let mergedConversation = conversation;
            let fileExists = false;
            try {
                await vscode.workspace.fs.stat(fileUri);
                fileExists = true;
            } catch (e) {
                fileExists = false;
            }
            if (fileExists) {
                const existingContent = Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString('utf8');
                const existingConversation: Conversation = JSON.parse(existingContent);
                const existingMessages = existingConversation.messages || [];
                const newMessages = conversation.messages || [];
                // Merge messages by bubbleId (or id if bubbleId is missing)
                const allMessages = [...existingMessages, ...newMessages];
                const seen = new Set<string>();
                const mergedMessages = allMessages.filter(msg => {
                    const key = msg.bubbleId || msg.id;
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                });
                mergedConversation = this.recalculateMetadata({
                    ...conversation,
                    messages: mergedMessages,
                    createdAt: existingConversation.createdAt ? new Date(existingConversation.createdAt) : new Date(conversation.createdAt),
                    updatedAt: new Date(),
                });
            } else {
                mergedConversation = this.recalculateMetadata(mergedConversation);
            }

            // Convert all date fields to local time strings
            const conversationToSave = {
                ...mergedConversation,
                createdAt: toLocalString(mergedConversation.createdAt),
                updatedAt: toLocalString(mergedConversation.updatedAt),
                messages: mergedConversation.messages.map(msg => ({
                    ...msg,
                    timestamp: toLocalString(msg.timestamp)
                }))
            };

            await vscode.workspace.fs.writeFile(fileUri, Buffer.from(JSON.stringify(conversationToSave, null, 2), 'utf8'));
            this.outputChannel.appendLine(`Saved conversation: ${conversation.title}`);

            // Trigger git-based conversation calculation
            await this.triggerGitBasedCalculation();
        } catch (error) {
            this.outputChannel.appendLine(`Error saving conversation: ${error}`);
            throw error;
        }
    }

    public async showHistoryView(): Promise<void> {
        const conversations = this.getAllConversations();
        if (conversations.length === 0) {
            vscode.window.showInformationMessage('No conversations found');
            return;
        }

        const items = conversations.map(conv => ({
            label: conv.title,
            description: `${conv.metadata.totalMessages} messages • ${this.formatTimestamp(conv.updatedAt)}`,
            detail: conv.metadata.workspacePath || 'Unknown workspace',
            conversation: conv
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a conversation to view'
        });

        if (selected) {
            await this.showConversationDetails(selected.conversation);
        }
    }

    private async showConversationDetails(conversation: Conversation): Promise<void> {
        const panel = vscode.window.createWebviewPanel(
            'conversationDetails',
            `Conversation: ${conversation.title}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        const content = this.formatConversationForWebview(conversation);
        panel.webview.html = content;
    }

    private formatConversationForWebview(conversation: Conversation): string {
        const messages = conversation.messages.map(msg => {
            const roleIcon = msg.role === 'user' ? '👤' : msg.role === 'assistant' ? '🤖' : '⚙️';
            const timestamp = this.formatTimestamp(msg.timestamp);
            const content = msg.filteredContent || msg.content;
            
            return `
                <div class="message ${msg.role}">
                    <div class="message-header">
                        <span class="role-icon">${roleIcon}</span>
                        <span class="role">${msg.role}</span>
                        <span class="timestamp">${timestamp}</span>
                    </div>
                    <div class="content">${this.escapeHtml(content)}</div>
                </div>
            `;
        }).join('');

        return `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 20px; }
                    .conversation-header { margin-bottom: 20px; padding: 15px; background: #f5f5f5; border-radius: 5px; }
                    .message { margin: 15px 0; padding: 15px; border-radius: 5px; }
                    .user { background: #e3f2fd; border-left: 4px solid #2196f3; }
                    .assistant { background: #f3e5f5; border-left: 4px solid #9c27b0; }
                    .system { background: #fff3e0; border-left: 4px solid #ff9800; }
                    .message-header { margin-bottom: 10px; font-size: 12px; color: #666; }
                    .role-icon { margin-right: 5px; }
                    .timestamp { float: right; }
                    .content { white-space: pre-wrap; line-height: 1.5; }
                    .filtered-notice { font-style: italic; color: #666; font-size: 12px; margin-top: 5px; }
                </style>
            </head>
            <body>
                <div class="conversation-header">
                    <h2>${conversation.title}</h2>
                    <p>Created: ${this.formatTimestamp(conversation.createdAt)}</p>
                    <p>Updated: ${this.formatTimestamp(conversation.updatedAt)}</p>
                    <p>Messages: ${conversation.metadata.totalMessages} (${conversation.metadata.userMessages} user, ${conversation.metadata.assistantMessages} assistant)</p>
                    ${conversation.metadata.workspacePath ? `<p>Workspace: ${conversation.metadata.workspacePath}</p>` : ''}
                </div>
                <div class="messages">
                    ${messages}
                </div>
            </body>
            </html>
        `;
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    private formatTimestamp(date: Date): string {
        switch (this.config.timestampFormat) {
            case 'ISO':
                return date.toISOString();
            case 'local':
                return date.toLocaleString();
            case 'relative':
                return this.getRelativeTime(date);
            default:
                return date.toISOString();
        }
    }

    private getRelativeTime(date: Date): string {
        const now = new Date();
        const diff = now.getTime() - date.getTime();
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);
        const days = Math.floor(diff / 86400000);

        if (minutes < 1) return 'just now';
        if (minutes < 60) return `${minutes}m ago`;
        if (hours < 24) return `${hours}h ago`;
        return `${days}d ago`;
    }

    public async clearHistory(): Promise<void> {
        try {
            const storagePath = this.getStoragePath();
            if (await fs.pathExists(storagePath)) {
                await fs.remove(storagePath);
            }
            this.conversations.clear();
            this.outputChannel.appendLine('Chat history cleared');
        } catch (error) {
            this.outputChannel.appendLine(`Error clearing history: ${error}`);
            throw error;
        }
    }

    private getStoragePath(): string {
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        return path.join(workspacePath || '', '.chatlogger');
    }

    private getCurrentConversation(): Conversation | null {
        // This will be implemented to get the current conversation
        // from the virtual document monitor
        return null;
    }

    public getAllConversations(): Conversation[] {
        return Array.from(this.conversations.values());
    }

    public addConversation(conversation: Conversation): void {
        this.conversations.set(conversation.id, conversation);
    }

    public getConversation(id: string): Conversation | undefined {
        return this.conversations.get(id);
    }

    public async triggerGitBasedCalculation(): Promise<void> {
        if (!this.gitTracker) {
            return;
        }

        try {
            const allConversations = this.getAllConversations();
            await this.gitTracker.triggerCalculation(allConversations);
            this.outputChannel.appendLine('Git-based conversation calculation completed');
        } catch (error) {
            this.outputChannel.appendLine(`Error in git-based calculation: ${error}`);
        }
    }

    public async loadSavedConversations() {
        try {
            // Get the workspace folder URI
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                this.outputChannel.appendLine('No workspace folder found');
                return;
            }
            // Build the .chatlogger/conversations directory URI
            const storageUri = vscode.Uri.joinPath(workspaceFolder.uri, '.chatlogger', 'conversations');

            // Ensure the directory exists (create if not)
            try {
                await vscode.workspace.fs.createDirectory(storageUri);
            } catch (e) {
                // Ignore if already exists
            }

            // List all files in the directory
            let files: [string, vscode.FileType][] = [];
            try {
                files = await vscode.workspace.fs.readDirectory(storageUri);
            } catch (e) {
                this.outputChannel.appendLine('No conversation directory found');
                return;
            }

            for (const [fileName, fileType] of files) {
                if (fileType === vscode.FileType.File && fileName.endsWith('.json')) {
                    const fileUri = vscode.Uri.joinPath(storageUri, fileName);
                    try {
                        const content = Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString('utf8');
                        const conversation: Conversation = JSON.parse(content);

                        // Convert string dates back to Date objects
                        conversation.createdAt = new Date(conversation.createdAt);
                        conversation.updatedAt = new Date(conversation.updatedAt);
                        conversation.messages.forEach(msg => {
                            msg.timestamp = new Date(msg.timestamp);
                        });

                        // Mark composerId and bubbleIds as processed in the monitor
                        if (conversation.metadata.composerId && this.monitor) {
                            const bubbleIds = conversation.messages
                                .map(msg => msg.bubbleId)
                                .filter((id): id is string => Boolean(id));
                            this.monitor.markComposerIdProcessed(conversation.metadata.composerId, bubbleIds);
                        }

                        this.conversations.set(conversation.id, conversation);
                    } catch (error) {
                        this.outputChannel.appendLine(`Error loading conversation file ${fileName}: ${error}`);
                    }
                }
            }
            this.outputChannel.appendLine(`Loaded ${this.conversations.size} saved conversations`);
        } catch (error) {
            this.outputChannel.appendLine(`Error loading conversations: ${error}`);
        }
    }
} 