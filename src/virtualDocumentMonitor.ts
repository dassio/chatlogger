import * as vscode from 'vscode';
import { ChatLogger, Conversation, ChatMessage } from './chatLogger';

export class VirtualDocumentMonitor implements vscode.Disposable {
    private chatLogger: ChatLogger;
    private disposables: vscode.Disposable[] = [];
    private currentConversation: Conversation | null = null;
    private config: any;

    constructor(chatLogger: ChatLogger) {
        this.chatLogger = chatLogger;
        this.loadConfiguration();
    }

    private loadConfiguration() {
        const config = vscode.workspace.getConfiguration('chatlogger');
        this.config = {
            autoSave: config.get('autoSave.enabled', true),
            ignoreCodeOutput: config.get('ignoreCodeOutput', true)
        };
    }

    public updateConfiguration() {
        this.loadConfiguration();
    }

    public start(): void {
        if (!this.config.autoSave) {
            return;
        }

        // Monitor for document changes
        const documentChangeListener = vscode.workspace.onDidChangeTextDocument(
            this.handleDocumentChange.bind(this)
        );

        // Monitor for active editor changes
        const activeEditorListener = vscode.window.onDidChangeActiveTextEditor(
            this.handleActiveEditorChange.bind(this)
        );

        // Monitor for document opens
        const documentOpenListener = vscode.workspace.onDidOpenTextDocument(
            this.handleDocumentOpen.bind(this)
        );

        this.disposables.push(
            documentChangeListener,
            activeEditorListener,
            documentOpenListener
        );
    }

    private async handleDocumentChange(event: vscode.TextDocumentChangeEvent): Promise<void> {
        const document = event.document;
        
        // Check if this is a Cursor chat document
        if (this.isCursorChatDocument(document)) {
            await this.processChatDocument(document);
        }
    }

    private async handleActiveEditorChange(editor: vscode.TextEditor | undefined): Promise<void> {
        if (editor && this.isCursorChatDocument(editor.document)) {
            await this.processChatDocument(editor.document);
        }
    }

    private async handleDocumentOpen(document: vscode.TextDocument): Promise<void> {
        if (this.isCursorChatDocument(document)) {
            await this.processChatDocument(document);
        }
    }

    private isCursorChatDocument(document: vscode.TextDocument): boolean {
        const fileName = document.fileName.toLowerCase();
        const uri = document.uri.toString();
        
        // Check for Cursor's virtual document patterns
        return (
            uri.includes('cursor://') ||
            uri.includes('chat') ||
            uri.includes('conversation') ||
            fileName.includes('chat') ||
            fileName.includes('conversation') ||
            document.languageId === 'markdown' && (
                fileName.includes('cursor') ||
                fileName.includes('ai') ||
                fileName.includes('assistant')
            )
        );
    }

    private async processChatDocument(document: vscode.TextDocument): Promise<void> {
        try {
            const content = document.getText();
            if (!content.trim()) {
                return;
            }

            // Parse the chat content
            const conversation = this.parseChatContent(content, document);
            if (conversation) {
                this.currentConversation = conversation;
                this.chatLogger.addConversation(conversation);
                
                // Auto-save if enabled
                if (this.config.autoSave) {
                    await this.chatLogger.saveConversation(conversation);
                }
            }
        } catch (error) {
            console.error('Error processing chat document:', error);
        }
    }

    private parseChatContent(content: string, document: vscode.TextDocument): Conversation | null {
        // Try different parsing strategies for Cursor chat formats
        
        // Strategy 1: Look for Cursor's specific chat format
        const cursorChatMatch = this.parseCursorChatFormat(content);
        if (cursorChatMatch) {
            return cursorChatMatch;
        }

        // Strategy 2: Look for markdown conversation format
        const markdownMatch = this.parseMarkdownConversation(content);
        if (markdownMatch) {
            return markdownMatch;
        }

        // Strategy 3: Look for JSON conversation format
        const jsonMatch = this.parseJsonConversation(content);
        if (jsonMatch) {
            return jsonMatch;
        }

        return null;
    }

    private parseCursorChatFormat(content: string): Conversation | null {
        // Cursor typically uses a specific format with user/assistant messages
        const lines = content.split('\n');
        const messages: ChatMessage[] = [];
        let currentRole: 'user' | 'assistant' | 'system' | null = null;
        let currentContent: string[] = [];
        let conversationTitle = 'Cursor Chat Conversation';

        for (const line of lines) {
            // Look for role indicators
            if (line.startsWith('### User:') || line.startsWith('**User:**') || line.startsWith('👤 User:')) {
                if (currentRole && currentContent.length > 0) {
                    messages.push(this.createMessage(currentRole, currentContent.join('\n')));
                }
                currentRole = 'user';
                currentContent = [line.replace(/^### User:|^\*\*User:\*\*|^👤 User:/, '').trim()];
            } else if (line.startsWith('### Assistant:') || line.startsWith('**Assistant:**') || line.startsWith('🤖 Assistant:')) {
                if (currentRole && currentContent.length > 0) {
                    messages.push(this.createMessage(currentRole, currentContent.join('\n')));
                }
                currentRole = 'assistant';
                currentContent = [line.replace(/^### Assistant:|^\*\*Assistant:\*\*|^🤖 Assistant:/, '').trim()];
            } else if (line.startsWith('### System:') || line.startsWith('**System:**') || line.startsWith('⚙️ System:')) {
                if (currentRole && currentContent.length > 0) {
                    messages.push(this.createMessage(currentRole, currentContent.join('\n')));
                }
                currentRole = 'system';
                currentContent = [line.replace(/^### System:|^\*\*System:\*\*|^⚙️ System:/, '').trim()];
            } else if (line.startsWith('# ')) {
                // Extract title from markdown header
                conversationTitle = line.replace('# ', '').trim();
            } else if (currentRole) {
                currentContent.push(line);
            }
        }

        // Add the last message
        if (currentRole && currentContent.length > 0) {
            messages.push(this.createMessage(currentRole, currentContent.join('\n')));
        }

        if (messages.length === 0) {
            return null;
        }

        return this.createConversation(conversationTitle, messages);
    }

    private parseMarkdownConversation(content: string): Conversation | null {
        // Parse markdown-style conversation
        const userMatches = content.match(/^##?\s*User[:\s]*\n([\s\S]*?)(?=^##?\s*Assistant|$)/gm);
        const assistantMatches = content.match(/^##?\s*Assistant[:\s]*\n([\s\S]*?)(?=^##?\s*User|$)/gm);

        const messages: ChatMessage[] = [];
        let conversationTitle = 'Markdown Chat Conversation';

        // Extract title
        const titleMatch = content.match(/^#\s*(.+)$/m);
        if (titleMatch) {
            conversationTitle = titleMatch[1].trim();
        }

        // Process user messages
        if (userMatches) {
            userMatches.forEach(match => {
                const content = match.replace(/^##?\s*User[:\s]*\n/, '').trim();
                if (content) {
                    messages.push(this.createMessage('user', content));
                }
            });
        }

        // Process assistant messages
        if (assistantMatches) {
            assistantMatches.forEach(match => {
                const content = match.replace(/^##?\s*Assistant[:\s]*\n/, '').trim();
                if (content) {
                    messages.push(this.createMessage('assistant', content));
                }
            });
        }

        if (messages.length === 0) {
            return null;
        }

        return this.createConversation(conversationTitle, messages);
    }

    private parseJsonConversation(content: string): Conversation | null {
        try {
            const parsed = JSON.parse(content);
            
            // Check if it's already a conversation object
            if (parsed.messages && Array.isArray(parsed.messages)) {
                const messages: ChatMessage[] = parsed.messages.map((msg: any) => 
                    this.createMessage(msg.role, msg.content)
                );
                return this.createConversation(parsed.title || 'JSON Chat Conversation', messages);
            }

            // Check if it's an array of messages
            if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].role) {
                const messages: ChatMessage[] = parsed.map((msg: any) => 
                    this.createMessage(msg.role, msg.content)
                );
                return this.createConversation('JSON Chat Conversation', messages);
            }
        } catch (error) {
            // Not valid JSON, continue to other parsing strategies
        }

        return null;
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

    private createConversation(title: string, messages: ChatMessage[]): Conversation {
        const conversationId = `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const now = new Date();
        
        const userMessages = messages.filter(msg => msg.role === 'user').length;
        const assistantMessages = messages.filter(msg => msg.role === 'assistant').length;
        const totalTokensEstimated = messages.reduce((sum, msg) => 
            sum + Math.ceil(msg.content.split(/\s+/).length * 1.3), 0
        );

        return {
            id: conversationId,
            createdAt: now,
            updatedAt: now,
            title,
            messages,
            metadata: {
                workspacePath: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
                fileContext: [],
                totalMessages: messages.length,
                userMessages,
                assistantMessages,
                totalTokensEstimated
            }
        };
    }

    public dispose(): void {
        this.disposables.forEach(disposable => disposable.dispose());
        this.disposables = [];
    }
} 