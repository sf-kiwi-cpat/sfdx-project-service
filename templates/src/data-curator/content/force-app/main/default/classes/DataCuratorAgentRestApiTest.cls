@IsTest
private class DataCuratorAgentRestApiTest {
    private class StubRuntime extends DataCuratorAgentRestApi.AgentRuntime {
        public Integer endSessionCalls = 0;
        public String lastEndedSessionId;

        public override DataCuratorAgentRestApi.AgentHealthResponse getHealth() {
            DataCuratorAgentRestApi.AgentHealthResponse response =
                new DataCuratorAgentRestApi.AgentHealthResponse();
            response.configured = true;
            response.missingEnv = new List<String>();
            response.apiHost = 'https://example.my.salesforce.com';
            response.agentId = 'DataCuratorAgent';
            return response;
        }

        public override DataCuratorAgentRestApi.AgentSessionResponse startSession(String greetingText) {
            DataCuratorAgentRestApi.AgentSessionResponse response =
                new DataCuratorAgentRestApi.AgentSessionResponse();
            response.sessionId = 'session-123';

            DataCuratorAgentRestApi.AgentMessageResponse message =
                new DataCuratorAgentRestApi.AgentMessageResponse();
            message.id = 'welcome-1';
            message.role = 'assistant';
            message.type = 'Inform';
            message.text = greetingText;
            message.citations = new List<DataCuratorAgentRestApi.AgentCitation>();

            response.messages = new List<DataCuratorAgentRestApi.AgentMessageResponse>{ message };
            return response;
        }

        public override DataCuratorAgentRestApi.AgentMessagesResponse sendMessage(
            String sessionId,
            String text
        ) {
            DataCuratorAgentRestApi.AgentMessagesResponse response =
                new DataCuratorAgentRestApi.AgentMessagesResponse();

            DataCuratorAgentRestApi.AgentMessageResponse message =
                new DataCuratorAgentRestApi.AgentMessageResponse();
            message.id = 'reply-1';
            message.role = 'assistant';
            message.type = 'Inform';
            message.text = 'Echo: ' + sessionId + ' / ' + text;
            message.citations = new List<DataCuratorAgentRestApi.AgentCitation>();

            response.messages = new List<DataCuratorAgentRestApi.AgentMessageResponse>{ message };
            return response;
        }

        public override void endSession(String sessionId) {
            endSessionCalls += 1;
            lastEndedSessionId = sessionId;
        }
    }

    @IsTest
    static void healthEndpointShouldReturnPayload() {
        StubRuntime stub = new StubRuntime();
        DataCuratorAgentRestApi.runtime = stub;

        RestRequest request = new RestRequest();
        request.requestURI = '/services/apexrest/data-curator-agent/v1/health';
        request.httpMethod = 'GET';
        RestContext.request = request;
        RestContext.response = new RestResponse();

        DataCuratorAgentRestApi.handleGet();
        DataCuratorAgentRestApi.AgentHealthResponse payload =
            (DataCuratorAgentRestApi.AgentHealthResponse) JSON.deserialize(
                RestContext.response.responseBody.toString(),
                DataCuratorAgentRestApi.AgentHealthResponse.class
            );

        System.assertEquals(true, payload.configured);
        System.assertEquals('DataCuratorAgent', payload.agentId);
        System.assertEquals(200, RestContext.response.statusCode);
    }

    @IsTest
    static void sessionEndpointShouldCreateWelcomeMessage() {
        StubRuntime stub = new StubRuntime();
        DataCuratorAgentRestApi.runtime = stub;

        RestRequest request = new RestRequest();
        request.requestURI = '/services/apexrest/data-curator-agent/v1/session';
        request.httpMethod = 'POST';
        request.requestBody = Blob.valueOf('{"text":"Hello there"}');
        RestContext.request = request;
        RestContext.response = new RestResponse();

        DataCuratorAgentRestApi.handlePost();
        DataCuratorAgentRestApi.AgentSessionResponse payload =
            (DataCuratorAgentRestApi.AgentSessionResponse) JSON.deserialize(
                RestContext.response.responseBody.toString(),
                DataCuratorAgentRestApi.AgentSessionResponse.class
            );

        System.assertEquals('session-123', payload.sessionId);
        System.assertEquals(1, payload.messages.size());
        System.assertEquals('Hello there', payload.messages[0].text);
        System.assertEquals(200, RestContext.response.statusCode);
    }

    @IsTest
    static void messagesEndpointShouldProxyConversationTurn() {
        StubRuntime stub = new StubRuntime();
        DataCuratorAgentRestApi.runtime = stub;

        RestRequest request = new RestRequest();
        request.requestURI = '/services/apexrest/data-curator-agent/v1/messages';
        request.httpMethod = 'POST';
        request.requestBody = Blob.valueOf(
            '{"sessionId":"session-123","text":"Summarize stale assets","sequenceId":1}'
        );
        RestContext.request = request;
        RestContext.response = new RestResponse();

        DataCuratorAgentRestApi.handlePost();
        DataCuratorAgentRestApi.AgentMessagesResponse payload =
            (DataCuratorAgentRestApi.AgentMessagesResponse) JSON.deserialize(
                RestContext.response.responseBody.toString(),
                DataCuratorAgentRestApi.AgentMessagesResponse.class
            );

        System.assertEquals(1, payload.messages.size());
        System.assert(payload.messages[0].text.contains('session-123'));
        System.assert(payload.messages[0].text.contains('Summarize stale assets'));
        System.assertEquals(200, RestContext.response.statusCode);
    }

    @IsTest
    static void deleteEndpointShouldReturnNoContent() {
        StubRuntime stub = new StubRuntime();
        DataCuratorAgentRestApi.runtime = stub;

        RestRequest request = new RestRequest();
        request.requestURI = '/services/apexrest/data-curator-agent/v1/session/session-123';
        request.httpMethod = 'DELETE';
        RestContext.request = request;
        RestContext.response = new RestResponse();

        DataCuratorAgentRestApi.handleDelete();

        System.assertEquals(1, stub.endSessionCalls);
        System.assertEquals('session-123', stub.lastEndedSessionId);
        System.assertEquals(204, RestContext.response.statusCode);
    }
}
