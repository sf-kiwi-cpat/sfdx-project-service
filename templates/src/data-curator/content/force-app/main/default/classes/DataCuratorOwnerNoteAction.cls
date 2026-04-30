public with sharing class DataCuratorOwnerNoteAction {
    public class Request {
        @InvocableVariable(label='Asset Name' required=false)
        public String asset_name;

        @InvocableVariable(label='Request Context' required=false)
        public String request_context;
    }

    public class Response {
        @InvocableVariable
        public String promptResponse;
    }

    @InvocableMethod(label='Data Curator Generate Owner Note' description='Generates a stewardship handoff note for the selected metadata asset.')
    public static List<Response> run(List<Request> requests) {
        List<Response> responses = new List<Response>();
        for (Request requestItem : requests) {
            Response responseItem = new Response();
            responseItem.promptResponse = DataCuratorGovernanceService.generateOwnerMessage(
                requestItem.asset_name,
                requestItem.request_context
            );
            responses.add(responseItem);
        }
        return responses;
    }
}
