public with sharing class DataCuratorAssignMetadataOwnerAction {
    public class Request {
        @InvocableVariable(label='Asset Name' required=true)
        public String asset_name;

        @InvocableVariable(label='Owner User Id' required=true)
        public String owner_user_id;
    }

    public class Response {
        @InvocableVariable
        public String assignment_status;

        @InvocableVariable
        public String audit_record_id;
    }

    @InvocableMethod(label='Data Curator Assign Metadata Owner' description='Assigns a user to a metadata asset and records an audit event.')
    public static List<Response> run(List<Request> requests) {
        List<Response> responses = new List<Response>();
        for (Request requestItem : requests) {
            DataCuratorGovernanceService.OwnerAssignmentResult serviceResult =
                DataCuratorGovernanceService.assignMetadataOwner(
                    requestItem.asset_name,
                    Id.valueOf(requestItem.owner_user_id)
                );
            Response responseItem = new Response();
            responseItem.assignment_status = serviceResult.assignmentStatus;
            responseItem.audit_record_id = String.valueOf(serviceResult.auditRecordId);
            responses.add(responseItem);
        }
        return responses;
    }
}
