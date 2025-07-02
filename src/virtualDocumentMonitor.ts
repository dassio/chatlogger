import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Database } from 'sqlite3';
import { ChatLogger, Conversation, ChatMessage } from './chatLogger';

export class VirtualDocumentMonitor implements vscode.Disposable {
    private chatLogger: ChatLogger;
    private disposables: vscode.Disposable[] = [];
    private currentConversation: Conversation | null = null;
    private config: any;
    private timer: NodeJS.Timeout | null = null;
    private isCheckingForChanges = false;
    private lastProcessedConversations = new Set<string>();
    private db: Database | null = null;


    constructor(chatLogger: ChatLogger) {
        this.chatLogger = chatLogger;
        this.loadConfiguration();
    }

    private loadConfiguration() {
        const config = vscode.workspace.getConfiguration('chatlogger');
        this.config = {
            autoSave: config.get('autoSave.enabled', true),
            ignoreCodeOutput: config.get('ignoreCodeOutput', true),
            checkInterval: config.get('checkInterval', 30000) // 30 seconds
        };
    }

    public updateConfiguration() {
        this.loadConfiguration();
    }

    public start(): void {
        this.chatLogger.outputChannel.appendLine('VirtualDocumentMonitor.start() called');
        
        if (!this.config.autoSave) {
            this.chatLogger.outputChannel.appendLine('Auto-save is disabled, not starting monitor');
            return;
        }

        this.chatLogger.outputChannel.appendLine('Auto-save is enabled, initializing...');
        this.initializeDatabase();
        this.startPeriodicCheck();
        this.chatLogger.outputChannel.appendLine('VirtualDocumentMonitor started successfully');
    }

    private getCursorStoragePath(): string {
        // Windows path: C:\Users\{username}\AppData\Roaming\Cursor\User\globalStorage
        const username = os.userInfo().username;
        return path.join('C:', 'Users', username, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage');
    }

    private getCursorDatabasePath(): string {
        const cursorStoragePath = this.getCursorStoragePath();
        return path.join(cursorStoragePath, 'state.vscdb');
    }

    private initializeDatabase(): void {
        try {
            const dbPath = this.getCursorDatabasePath();
            
            if (!fs.existsSync(dbPath)) {
                this.chatLogger.outputChannel.appendLine(`Cursor database does not exist: ${dbPath}`);
                return;
            }

            this.db = new Database(dbPath, (err) => {
                if (err) {
                    this.chatLogger.outputChannel.appendLine(`Failed to initialize database: ${err}`);
                } else {
                    this.chatLogger.outputChannel.appendLine(`Database connection established: ${dbPath}`);
                }
            });
        } catch (error) {
            this.chatLogger.outputChannel.appendLine(`Failed to initialize database: ${error}`);
        }
    }

    private startPeriodicCheck(): void {
        this.chatLogger.outputChannel.appendLine(`Starting periodic check with interval: ${this.config.checkInterval}ms`);
        this.timer = setInterval(() => {
            this.chatLogger.outputChannel.appendLine('Timer triggered - calling checkForChanges');
            this.checkForChanges('periodic');
        }, this.config.checkInterval);
        this.chatLogger.outputChannel.appendLine('Periodic check timer started');
    }

    private async checkForChanges(trigger: string): Promise<void> {
        this.chatLogger.outputChannel.appendLine(`checkForChanges called with trigger: ${trigger}`);
        
        if (this.isCheckingForChanges) {
            this.chatLogger.outputChannel.appendLine('Already checking for changes, skipping...');
            return;
        }
        
        if (!this.db) {
            this.chatLogger.outputChannel.appendLine('Database not initialized, skipping...');
            return;
        }

        this.isCheckingForChanges = true;

        try {
            this.chatLogger.outputChannel.appendLine(`Checking for conversation changes (trigger: ${trigger})`);
            
            const conversations = await this.loadConversationsFromDatabase();
            
            for (const conversation of conversations) {
                if (conversation && !this.lastProcessedConversations.has(conversation.id)) {
                    this.currentConversation = conversation;
                    this.chatLogger.addConversation(conversation);
                    this.lastProcessedConversations.add(conversation.id);
                    
                    // Auto-save if enabled
                    if (this.config.autoSave) {
                        await this.chatLogger.saveConversation(conversation);
                    }
                }
            }
        } catch (error) {
            this.chatLogger.outputChannel.appendLine(`Error checking for changes: ${error}`);
        } finally {
            this.isCheckingForChanges = false;
        }
    }

    private async loadConversationsFromDatabase(): Promise<Conversation[]> {
        return new Promise((resolve) => {
            try {
                if (!this.db) {
                    resolve([]);
                    return;
                }

                const conversations: Conversation[] = [];

                // Query the cursorDiskKV table for conversation data
                this.db.all(`
                    SELECT key, value 
                    FROM cursorDiskKV 
                    WHERE key LIKE '%conversation%' 
                       OR key LIKE '%composer%' 
                       OR key LIKE '%chat%'
                       OR key LIKE '%composerData%'
                    ORDER BY key
                `, (err, rows: Array<{ key: string; value: string }>) => {
                    if (err) {
                        this.chatLogger.outputChannel.appendLine(`Error loading conversations from database: ${err}`);
                        resolve([]);
                        return;
                    }

                    for (const row of rows) {
                        try {
                            const data = JSON.parse(row.value);
                            const conversation = this.parseConversationData(data, row.key);
                            if (conversation) {
                                conversations.push(conversation);
                            }
                        } catch (error) {
                            this.chatLogger.outputChannel.appendLine(`Error parsing conversation data from key ${row.key}: ${error}`);
                        }
                    }

                    this.chatLogger.outputChannel.appendLine(`Loaded ${conversations.length} conversations from database`);
                    resolve(conversations);
                });
            } catch (error) {
                this.chatLogger.outputChannel.appendLine(`Error loading conversations from database: ${error}`);
                resolve([]);
            }
        });
    }

    private parseConversationData(data: any, key: string): Conversation | null {
        try {
            const messages: ChatMessage[] = [];
            let conversationTitle = 'Cursor Chat Conversation';
            let composerId: string | undefined;
            let sessionId: string | undefined;

            // Extract conversation data from various possible structures
            if (data.conversation && Array.isArray(data.conversation)) {
                for (const message of data.conversation) {
                    if (message && message.role && message.content) {
                        messages.push(this.createMessage(message.role, message.content));
                    }
                }
            }

            // Check for composer data
            if (data.composerId) {
                composerId = data.composerId;
                conversationTitle = data.name || `Composer ${composerId}`;
                
                if (data.conversation && Array.isArray(data.conversation)) {
                    for (const message of data.conversation) {
                        if (message && message.type && message.text) {
                            const role = this.mapMessageTypeToRole(message.type);
                            if (role) {
                                messages.push(this.createMessage(role, message.text));
                            }
                        }
                    }
                }

                // Process bubble data if available
                if (data.fullConversationHeadersOnly && Array.isArray(data.fullConversationHeadersOnly)) {
                    for (const bubble of data.fullConversationHeadersOnly) {
                        if (bubble && bubble.type && bubble.text) {
                            const role = this.mapMessageTypeToRole(bubble.type);
                            if (role) {
                                messages.push(this.createMessage(role, bubble.text));
                            }
                        }
                    }
                }
            }

            // Check for session data
            if (data.sessionId) {
                sessionId = data.sessionId;
                conversationTitle = data.title || `Session ${sessionId}`;
                
                if (data.requests && Array.isArray(data.requests)) {
                    for (const request of data.requests) {
                        if (request.message && request.message.text) {
                            messages.push(this.createMessage('user', request.message.text));
                        }

                        if (request.response && Array.isArray(request.response)) {
                            let assistantContent = '';
                            for (const response of request.response) {
                                if (response.value) {
                                    assistantContent += response.value;
                                }
                            }
                            if (assistantContent.trim()) {
                                messages.push(this.createMessage('assistant', assistantContent));
                            }
                        }
                    }
                }
            }

            if (messages.length === 0) {
                return null;
            }

            return this.createConversation(conversationTitle, messages, data, key);
        } catch (error) {
            this.chatLogger.outputChannel.appendLine(`Error parsing conversation data: ${error}`);
            return null;
        }
    }

    private mapMessageTypeToRole(type: number): 'user' | 'assistant' | 'system' | null {
        // Cursor message type mapping
        // Type 1 is typically user, Type 2 is typically assistant
        switch (type) {
            case 1:
                return 'user';
            case 2:
                return 'assistant';
            case 0:
                return 'system';
            default:
                return null;
        }
    }

    private createMessage(role: 'user' | 'assistant' | 'system', content: string): ChatMessage {
        const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // Filter content if needed
        const { filteredContent, metadata } = this.filterMessageContent(content, role);
        
        return {
            id: messageId,
            timestamp: new Date(),
            role,
            content,
            filteredContent,
            metadata
        };
    }

    private filterMessageContent(content: string, role: string): { filteredContent?: string; metadata: any } {
        const metadata = {
            hasCodeBlocks: false,
            codeLanguage: undefined as string | undefined,
            messageLength: content.length,
            isFiltered: false
        };

        if (!this.config.ignoreCodeOutput || role !== 'assistant') {
            // Check for code blocks for metadata
            const codeBlockRegex = /```(\w+)?[\s\S]*?```/g;
            const matches = content.match(codeBlockRegex);
            if (matches && matches.length > 0) {
                metadata.hasCodeBlocks = true;
                const langMatch = matches[0].match(/```(\w+)/);
                if (langMatch) {
                    metadata.codeLanguage = langMatch[1];
                }
            }
            return { metadata };
        }

        // Filter assistant code blocks
        let filteredContent = content;
        metadata.isFiltered = true;

        // Remove code blocks
        filteredContent = content.replace(/```[\s\S]*?```/g, '[CODE_BLOCK_FILTERED]');
        
        // Remove inline code
        filteredContent = filteredContent.replace(/`[^`]+`/g, '[INLINE_CODE_FILTERED]');

        // Check for code blocks for metadata
        const codeBlockRegex = /```(\w+)?[\s\S]*?```/g;
        const matches = content.match(codeBlockRegex);
        if (matches && matches.length > 0) {
            metadata.hasCodeBlocks = true;
            const langMatch = matches[0].match(/```(\w+)/);
            if (langMatch) {
                metadata.codeLanguage = langMatch[1];
            }
        }

        return { filteredContent, metadata };
    }

    private createConversation(title: string, messages: ChatMessage[], data?: any, key?: string): Conversation {
        const conversationId = `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const now = new Date();
        
        const userMessages = messages.filter(msg => msg.role === 'user').length;
        const assistantMessages = messages.filter(msg => msg.role === 'assistant').length;
        const totalTokensEstimated = messages.reduce((sum, msg) => 
            sum + Math.ceil(msg.content.split(/\s+/).length * 1.3), 0
        );

        return {
            id: conversationId,
            createdAt: data?.createdAt ? new Date(data.createdAt) : now,
            updatedAt: data?.lastUpdatedAt ? new Date(data.lastUpdatedAt) : now,
            title,
            messages,
            metadata: {
                workspacePath: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
                fileContext: [],
                totalMessages: messages.length,
                userMessages,
                assistantMessages,
                totalTokensEstimated,
                composerId: data?.composerId,
                sessionId: data?.sessionId,
                source: 'cursor-database',
                filePath: key
            }
        };
    }

    public dispose(): void {
        if (this.db) {
            this.db.close((err) => {
                if (err) {
                    this.chatLogger.outputChannel.appendLine(`Error closing database: ${err}`);
                }
            });
            this.db = null;
        }

        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }

        this.disposables.forEach(disposable => disposable.dispose());
        this.disposables = [];
    }
} 