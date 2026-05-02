@RestResource(urlMapping='/data-curator-agent/v1/*')
global with sharing class DataCuratorAgentRestApi {
    private static final String API_BASE_PATH = '/services/apexrest/data-curator-agent/v1/';
    private static final String ROUTE_PREFIX = 'data-curator-agent/v1/';
    private static final String SESSION_GREETING =
        'Greet the Salesforce admin in one short sentence and mention stale metadata, ownership, and duplicate cleanup.';

    @TestVisible
    private static AgentRuntime runtime = new AgentRuntime();

    global class AgentHealthResponse {
        public Boolean configured;
        public List<String> missingEnv;
        public String apiHost;
        public String agentId;
    }

    global class AgentMessageResponse {
        public String id;
        public String role;
        public String type;
        public String text;
        public List<AgentCitation> citations;
    }

    global class AgentCitation {
        public String title;
        public String url;
    }

    global class AgentSessionResponse {
        public String sessionId;
        public List<AgentMessageResponse> messages;
    }

    global class AgentMessagesResponse {
        public List<AgentMessageResponse> messages;
    }

    global class ErrorResponse {
        public String error;
        public Object details;

        public ErrorResponse(String errorMessage, Object errorDetails) {
            error = errorMessage;
            details = errorDetails;
        }
    }

    public class SessionRequest {
        public String text;
    }

    public class MessageRequest {
        public String sessionId;
        public String text;
        public Integer sequenceId;
    }

    public class AgentInvocationResult {
        public String agentApiName;
        public String responseText;
        public String sessionId;
    }

    public virtual class AgentRuntime {
        public virtual AgentHealthResponse getHealth() {
            AgentHealthResponse response = new AgentHealthResponse();
            response.configured = true;
            response.missingEnv = new List<String>();
            response.apiHost = URL.getOrgDomainUrl().toExternalForm();
            response.agentId = getPreferredAgentApiName();
            return response;
        }

        public virtual AgentSessionResponse startSession(String greetingText) {
            AgentInvocationResult invocation = invokeAgent(greetingText, null);
            AgentSessionResponse response = new AgentSessionResponse();
            response.sessionId = invocation.sessionId;
            response.messages = buildMessages(invocation.responseText, invocation.sessionId, 'welcome');
            return response;
        }

        public virtual AgentMessagesResponse sendMessage(String sessionId, String text) {
            if (String.isBlank(sessionId)) {
                throw buildRestException('A valid `sessionId` is required.', 400);
            }

            if (String.isBlank(text)) {
                throw buildRestException('A non-empty `text` value is required.', 400);
            }

            AgentInvocationResult invocation = invokeAgent(text, sessionId);
            AgentMessagesResponse response = new AgentMessagesResponse();
            response.messages = buildMessages(invocation.responseText, invocation.sessionId, 'reply');
            return response;
        }

        public virtual void endSession(String sessionId) {
            // Invocable agent actions do not currently expose an Apex session-end API.
            // We treat reset as a client-side concern and let the platform expire the session.
        }

        protected AgentInvocationResult invokeAgent(String userMessage, String sessionId) {
            List<String> failures = new List<String>();

            for (String agentApiName : getAgentApiNameCandidates()) {
                try {
                    Invocable.Action action = Invocable.Action.createCustomAction(
                        'generateAiAgentResponse',
                        agentApiName
                    );
                    action.setInvocationParameter('userMessage', userMessage);
                    if (String.isNotBlank(sessionId)) {
                        action.setInvocationParameter('sessionId', sessionId);
                    }

                    List<Invocable.Action.Result> results = action.invoke();
                    if (results.isEmpty()) {
                        failures.add(agentApiName + ': no result returned');
                        continue;
                    }

                    Invocable.Action.Result result = results[0];
                    if (!result.isSuccess()) {
                        failures.add(agentApiName + ': action returned an unsuccessful result');
                        continue;
                    }

                    Map<String, Object> outputParameters = result.getOutputParameters();
                    AgentInvocationResult invocation = new AgentInvocationResult();
                    invocation.agentApiName = agentApiName;
                    invocation.responseText = normalizeAgentResponse(outputParameters.get('agentResponse'));
                    invocation.sessionId = stringValue(outputParameters.get('sessionId'));

                    if (String.isBlank(invocation.responseText)) {
                        invocation.responseText =
                            'The agent completed the request but did not return displayable text.';
                    }

                    return invocation;
                } catch (Exception error) {
                    failures.add(agentApiName + ': ' + error.getMessage());
                }
            }

            throw buildRestException(
                'Unable to invoke the Data Curator agent. ' + String.join(failures, ' | '),
                500
            );
        }
    }

    global class DataCuratorAgentRestException extends Exception {
        public Integer statusCode;
        public String publicMessage;
    }

    @HttpGet
    global static void handleGet() {
        try {
            if (getRoute() == 'health') {
                writeJson(200, runtime.getHealth());
                return;
            }

            throw buildRestException('Resource not found.', 404);
        } catch (Exception error) {
            handleError(error);
        }
    }

    @HttpPost
    global static void handlePost() {
        try {
            String route = getRoute();

            if (route == 'session') {
                SessionRequest payload = parseSessionRequest();
                String greeting = String.isBlank(payload == null ? null : payload.text)
                    ? SESSION_GREETING
                    : payload.text;
                writeJson(200, runtime.startSession(greeting));
                return;
            }

            if (route == 'messages') {
                MessageRequest payload = parseMessageRequest();
                writeJson(200, runtime.sendMessage(
                    payload == null ? null : payload.sessionId,
                    payload == null ? null : payload.text
                ));
                return;
            }

            throw buildRestException('Resource not found.', 404);
        } catch (Exception error) {
            handleError(error);
        }
    }

    @HttpDelete
    global static void handleDelete() {
        try {
            String route = getRoute();
            if (!route.startsWith('session/')) {
                throw buildRestException('Resource not found.', 404);
            }

            String sessionId = route.substring('session/'.length());
            runtime.endSession(sessionId);
            RestContext.response.statusCode = 204;
            RestContext.response.responseBody = Blob.valueOf('');
        } catch (Exception error) {
            handleError(error);
        }
    }

    private static void handleError(Exception error) {
        Integer statusCode = 500;
        String message = error.getMessage();
        if (error instanceof DataCuratorAgentRestException) {
            statusCode = ((DataCuratorAgentRestException) error).statusCode;
            message = ((DataCuratorAgentRestException) error).publicMessage;
        }

        writeJson(statusCode, new ErrorResponse(message, null));
    }

    private static String getRoute() {
        String requestUri = RestContext.request.requestURI;
        if (String.isBlank(requestUri)) {
            return '';
        }

        Integer markerIndex = requestUri.indexOf(API_BASE_PATH);
        if (markerIndex >= 0) {
            return requestUri.substring(markerIndex + API_BASE_PATH.length());
        }

        markerIndex = requestUri.indexOf(ROUTE_PREFIX);
        if (markerIndex >= 0) {
            return requestUri.substring(markerIndex + ROUTE_PREFIX.length());
        }

        return requestUri.startsWith('/') ? requestUri.substring(1) : requestUri;
    }

    private static SessionRequest parseSessionRequest() {
        if (RestContext.request == null || RestContext.request.requestBody == null) {
            return null;
        }

        String body = RestContext.request.requestBody.toString();
        if (String.isBlank(body)) {
            return null;
        }

        return (SessionRequest) JSON.deserialize(body, SessionRequest.class);
    }

    private static MessageRequest parseMessageRequest() {
        if (RestContext.request == null || RestContext.request.requestBody == null) {
            return null;
        }

        String body = RestContext.request.requestBody.toString();
        if (String.isBlank(body)) {
            return null;
        }

        return (MessageRequest) JSON.deserialize(body, MessageRequest.class);
    }

    private static void writeJson(Integer statusCode, Object payload) {
        RestContext.response.statusCode = statusCode;
        RestContext.response.addHeader('Content-Type', 'application/json');
        RestContext.response.responseBody = Blob.valueOf(JSON.serialize(payload));
    }

    private static DataCuratorAgentRestException buildRestException(
        String message,
        Integer statusCode
    ) {
        DataCuratorAgentRestException error = new DataCuratorAgentRestException();
        error.statusCode = statusCode;
        error.publicMessage = message;
        return error;
    }

    private static List<AgentMessageResponse> buildMessages(
        String text,
        String sessionId,
        String suffix
    ) {
        AgentMessageResponse message = new AgentMessageResponse();
        message.id = String.join(
            new List<String>{
                'agent',
                String.isBlank(sessionId) ? 'session' : sessionId,
                suffix
            },
            '-'
        );
        message.role = 'assistant';
        message.type = 'Inform';
        message.text = text;
        message.citations = new List<AgentCitation>();
        return new List<AgentMessageResponse>{ message };
    }

    private static String getPreferredAgentApiName() {
        return getAgentApiNameCandidates()[0];
    }

    private static List<String> getAgentApiNameCandidates() {
        return new List<String>{ 'DataCuratorAgent', 'DataCuratorAgent_1' };
    }

    private static String stringValue(Object value) {
        return value == null ? null : String.valueOf(value);
    }

    private static String normalizeAgentResponse(Object value) {
        if (value == null) {
            return null;
        }

        if (value instanceof String) {
            String textValue = (String) value;
            if (textValue.startsWith('{') || textValue.startsWith('[')) {
                try {
                    return extractAgentText(JSON.deserializeUntyped(textValue));
                } catch (Exception ignored) {
                    return textValue;
                }
            }

            return textValue;
        }

        return extractAgentText(value);
    }

    private static String extractAgentText(Object value) {
        if (value instanceof Map<String, Object>) {
            Map<String, Object> payload = (Map<String, Object>) value;
            if (payload.containsKey('value')) {
                return stringValue(payload.get('value'));
            }
        }

        if (value instanceof List<Object>) {
            List<String> textParts = new List<String>();
            for (Object item : (List<Object>) value) {
                String extracted = extractAgentText(item);
                if (String.isNotBlank(extracted)) {
                    textParts.add(extracted);
                }
            }

            if (!textParts.isEmpty()) {
                return String.join(textParts, '\n\n');
            }
        }

        return stringValue(value);
    }
}
