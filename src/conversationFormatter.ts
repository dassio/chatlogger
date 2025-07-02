import { Conversation, ChatMessage } from './chatLogger';

export class ConversationFormatter {
    public formatConversation(conversation: Conversation, format: string): string {
        switch (format.toLowerCase()) {
            case 'markdown':
                return this.toMarkdown(conversation);
            case 'json':
                return this.toJson(conversation);
            case 'txt':
                return this.toPlainText(conversation);
            default:
                throw new Error(`Unsupported format: ${format}`);
        }
    }

    private toMarkdown(conversation: Conversation): string {
        let markdown = `# ${conversation.title}\n\n`;
        
        // Metadata
        markdown += `**Created:** ${conversation.createdAt.toISOString()}\n`;
        markdown += `**Updated:** ${conversation.updatedAt.toISOString()}\n`;
        if (conversation.metadata.workspacePath) {
            markdown += `**Workspace:** ${conversation.metadata.workspacePath}\n`;
        }
        markdown += `**Messages:** ${conversation.metadata.totalMessages} (${conversation.metadata.userMessages} user, ${conversation.metadata.assistantMessages} assistant)\n`;
        markdown += `**Estimated Tokens:** ${conversation.metadata.totalTokensEstimated}\n\n`;

        // Messages
        for (const message of conversation.messages) {
            const roleIcon = this.getRoleIcon(message.role);
            const timestamp = message.timestamp.toISOString();
            
            markdown += `## ${roleIcon} ${message.role} - ${timestamp}\n\n`;
            
            if (message.metadata.isFiltered) {
                markdown += '*[Code blocks have been filtered out]*\n\n';
            }

            const contentToShow = message.filteredContent || message.content;
            markdown += `${contentToShow}\n\n`;
        }

        return markdown;
    }

    private toJson(conversation: Conversation): string {
        return JSON.stringify(conversation, null, 2);
    }

    private toPlainText(conversation: Conversation): string {
        let text = `Conversation: ${conversation.title}\n`;
        text += `Created: ${conversation.createdAt.toISOString()}\n`;
        text += `Updated: ${conversation.updatedAt.toISOString()}\n`;
        text += `Messages: ${conversation.metadata.totalMessages} (${conversation.metadata.userMessages} user, ${conversation.metadata.assistantMessages} assistant)\n`;
        text += `Estimated Tokens: ${conversation.metadata.totalTokensEstimated}\n`;
        if (conversation.metadata.workspacePath) {
            text += `Workspace: ${conversation.metadata.workspacePath}\n`;
        }
        text += '\n';

        for (const message of conversation.messages) {
            const timestamp = message.timestamp.toISOString();
            const contentToShow = message.filteredContent || message.content;
            
            text += `[${timestamp}] ${message.role.toUpperCase()}: ${contentToShow}\n\n`;
        }

        return text;
    }

    private getRoleIcon(role: string): string {
        switch (role) {
            case 'user':
                return '👤';
            case 'assistant':
                return '🤖';
            case 'system':
                return '⚙️';
            default:
                return '💬';
        }
    }

    public formatTimestamp(date: Date, format: string): string {
        switch (format.toLowerCase()) {
            case 'iso':
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
} 