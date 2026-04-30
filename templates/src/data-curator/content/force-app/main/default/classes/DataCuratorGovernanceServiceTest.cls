@IsTest
private class DataCuratorGovernanceServiceTest {
    @TestSetup
    static void setupData() {
        User ownerOne = createUser('owner.one');
        User ownerTwo = createUser('owner.two');

        insert new List<Metadata_Asset__c>{
            new Metadata_Asset__c(
                Name = 'Finance Ledgers',
                API_Name__c = 'Finance_Ledgers__mdt',
                Asset_Type__c = 'Object',
                Department__c = 'Finance',
                Owner_User__c = ownerOne.Id,
                Health_Status__c = 'Healthy',
                Health_Score__c = 95,
                Risk_Level__c = 'Medium',
                Last_Used_On__c = Date.today().addDays(-12),
                Last_Attested_On__c = Date.today().addDays(-20),
                Duplicate_Group_Key__c = 'FIN-LEDGER',
                Stale_Days__c = 12,
                Source_System__c = 'Core'
            ),
            new Metadata_Asset__c(
                Name = 'Finance Ledgers Copy',
                API_Name__c = 'Finance_Ledgers_Copy__mdt',
                Asset_Type__c = 'Object',
                Department__c = 'Finance',
                Owner_User__c = ownerTwo.Id,
                Health_Status__c = 'Duplicate',
                Health_Score__c = 41,
                Risk_Level__c = 'High',
                Last_Used_On__c = Date.today().addDays(-35),
                Last_Attested_On__c = Date.today().addDays(-60),
                Duplicate_Group_Key__c = 'FIN-LEDGER',
                Stale_Days__c = 35,
                Source_System__c = 'Core'
            ),
            new Metadata_Asset__c(
                Name = 'Security Auth Logs',
                API_Name__c = 'Security_Auth_Logs__mdt',
                Asset_Type__c = 'Integration',
                Department__c = 'Security',
                Health_Status__c = 'Stale',
                Health_Score__c = 25,
                Risk_Level__c = 'Critical',
                Last_Used_On__c = Date.today().addDays(-240),
                Last_Attested_On__c = Date.today().addDays(-300),
                Stale_Days__c = 240,
                Source_System__c = 'Shield'
            ),
            new Metadata_Asset__c(
                Name = 'Marketing Segmentation',
                API_Name__c = 'Marketing_Segmentation__mdt',
                Asset_Type__c = 'Flow',
                Department__c = 'Marketing',
                Owner_User__c = ownerOne.Id,
                Health_Status__c = 'NeedsReview',
                Health_Score__c = 61,
                Risk_Level__c = 'High',
                Last_Used_On__c = Date.today().addDays(-100),
                Last_Attested_On__c = Date.today().addDays(-120),
                Stale_Days__c = 100,
                Source_System__c = 'Marketing Cloud'
            ),
            new Metadata_Asset__c(
                Name = 'Finance Forecast Sync',
                API_Name__c = 'Finance_Forecast_Sync__mdt',
                Asset_Type__c = 'Integration',
                Department__c = 'Finance',
                Owner_User__c = ownerTwo.Id,
                Health_Status__c = 'Healthy',
                Health_Score__c = 88,
                Risk_Level__c = 'Low',
                Last_Used_On__c = Date.today().addDays(-8),
                Last_Attested_On__c = Date.today().addDays(-15),
                Stale_Days__c = 8,
                Source_System__c = 'MuleSoft'
            )
        };
    }

    @IsTest
    static void inventoryAndStaleReviewShouldReturnExpectedMetrics() {
        Test.startTest();
        DataCuratorGovernanceService.InventoryResult inventoryResult =
            DataCuratorGovernanceService.getMetadataInventory('Finance', 'all');
        DataCuratorGovernanceService.StaleReviewResult staleReviewResult =
            DataCuratorGovernanceService.runStaleReview('Security', 180);
        Test.stopTest();

        System.assertEquals('Finance', inventoryResult.departmentFilterUsed);
        System.assertEquals(0, inventoryResult.unassignedCount);
        System.assertEquals(0, inventoryResult.staleCount);
        System.assert(inventoryResult.healthScore > 0);
        System.assert(inventoryResult.inventorySnapshot.contains('"totalAssets"'));

        System.assertEquals(1, staleReviewResult.staleAssetCount);
        System.assertEquals(1, staleReviewResult.criticalAssetCount);
        System.assert(staleReviewResult.reviewSnapshot.contains('Security Auth Logs'));
    }

    @IsTest
    static void ownerProposalAssignmentAndDuplicatePlanShouldWork() {
        User fallbackOwner = [SELECT Id FROM User WHERE Email = 'owner.one@example.com' LIMIT 1];

        Test.startTest();
        DataCuratorGovernanceService.OwnerProposalResult ownerProposal =
            DataCuratorGovernanceService.proposeOwnerAssignment('Security Auth Logs', 'Security');
        DataCuratorGovernanceService.OwnerAssignmentResult assignmentResult =
            DataCuratorGovernanceService.assignMetadataOwner('Security Auth Logs', fallbackOwner.Id);
        DataCuratorGovernanceService.DuplicatePlanResult duplicatePlan =
            DataCuratorGovernanceService.buildDuplicateCleanupPlan('Finance', 0.80);
        Test.stopTest();

        System.assertNotEquals(null, ownerProposal.recommendedOwnerId);
        System.assert(ownerProposal.reasoningSummary.contains('Recommended'));
        System.assert(assignmentResult.assignmentStatus.contains('Assigned'));
        System.assertNotEquals(null, assignmentResult.auditRecordId);
        System.assertEquals(1, duplicatePlan.duplicateClusterCount);
        System.assert(duplicatePlan.projectedMonthlySavings > 0);
        System.assert(
            DataCuratorGovernanceService.generateGovernanceSummary('Today', '{"departmentFilterUsed":"Finance","totalAssets":2,"healthScore":88.5,"staleCount":1,"unassignedCount":0,"duplicateClusterCount":1,"ownershipCoverage":100}')
                .contains('Executive Summary')
        );
        System.assert(
            DataCuratorGovernanceService.generateStaleBrief('Follow up', '{"departmentFilterUsed":"Security","staleThresholdDays":180,"staleAssetCount":1,"criticalAssetCount":1}')
                .contains('Stale Metadata Brief')
        );
        System.assert(
            DataCuratorGovernanceService.generateOwnerMessage('Security Auth Logs', 'Use a collaborative tone')
                .contains('Security Auth Logs')
        );
        System.assert(
            DataCuratorGovernanceService.generateCleanupSummary('Keep it concise', '{"departmentFilterUsed":"Finance","duplicateClusterCount":1,"projectedMonthlySavings":250}')
                .contains('Duplicate Cleanup Summary')
        );
    }

    @IsTest
    static void invocableActionsShouldExposeContracts() {
        User targetOwner = [SELECT Id FROM User WHERE Email = 'owner.two@example.com' LIMIT 1];

        DataCuratorGetMetadataInventoryAction.Request inventoryRequest =
            new DataCuratorGetMetadataInventoryAction.Request();
        inventoryRequest.department_filter = 'Finance';
        inventoryRequest.status_filter = 'all';

        DataCuratorRunStaleMetadataReviewAction.Request staleRequest =
            new DataCuratorRunStaleMetadataReviewAction.Request();
        staleRequest.department_filter = 'Security';
        staleRequest.stale_threshold_days = 180;

        DataCuratorProposeMetadataOwnerAction.Request proposalRequest =
            new DataCuratorProposeMetadataOwnerAction.Request();
        proposalRequest.asset_name = 'Security Auth Logs';
        proposalRequest.department_filter = 'Security';

        DataCuratorAssignMetadataOwnerAction.Request assignmentRequest =
            new DataCuratorAssignMetadataOwnerAction.Request();
        assignmentRequest.asset_name = 'Security Auth Logs';
        assignmentRequest.owner_user_id = String.valueOf(targetOwner.Id);

        DataCuratorDuplicatePlanAction.Request duplicateRequest =
            new DataCuratorDuplicatePlanAction.Request();
        duplicateRequest.department_filter = 'Finance';
        duplicateRequest.confidence_threshold = 0.80;

        DataCuratorGovSummaryAction.Request govSummaryRequest =
            new DataCuratorGovSummaryAction.Request();
        govSummaryRequest.request_context = 'Executive briefing';
        govSummaryRequest.inventory_snapshot =
            '{"departmentFilterUsed":"Finance","totalAssets":2,"healthScore":88.5,"staleCount":1,"unassignedCount":0,"duplicateClusterCount":1,"ownershipCoverage":100}';

        DataCuratorStaleBriefAction.Request staleBriefRequest =
            new DataCuratorStaleBriefAction.Request();
        staleBriefRequest.request_context = 'Summarize risk';
        staleBriefRequest.review_snapshot =
            '{"departmentFilterUsed":"Security","staleThresholdDays":180,"staleAssetCount":1,"criticalAssetCount":1}';

        DataCuratorOwnerNoteAction.Request ownerNoteRequest =
            new DataCuratorOwnerNoteAction.Request();
        ownerNoteRequest.asset_name = 'Security Auth Logs';
        ownerNoteRequest.request_context = 'Concise note';

        DataCuratorCleanupBriefAction.Request cleanupBriefRequest =
            new DataCuratorCleanupBriefAction.Request();
        cleanupBriefRequest.request_context = 'Approval summary';
        cleanupBriefRequest.plan_summary =
            '{"departmentFilterUsed":"Finance","duplicateClusterCount":1,"projectedMonthlySavings":250}';

        Test.startTest();
        List<DataCuratorGetMetadataInventoryAction.Response> inventoryResponses =
            DataCuratorGetMetadataInventoryAction.run(new List<DataCuratorGetMetadataInventoryAction.Request>{ inventoryRequest });
        List<DataCuratorRunStaleMetadataReviewAction.Response> staleResponses =
            DataCuratorRunStaleMetadataReviewAction.run(new List<DataCuratorRunStaleMetadataReviewAction.Request>{ staleRequest });
        List<DataCuratorProposeMetadataOwnerAction.Response> proposalResponses =
            DataCuratorProposeMetadataOwnerAction.run(new List<DataCuratorProposeMetadataOwnerAction.Request>{ proposalRequest });
        List<DataCuratorAssignMetadataOwnerAction.Response> assignmentResponses =
            DataCuratorAssignMetadataOwnerAction.run(new List<DataCuratorAssignMetadataOwnerAction.Request>{ assignmentRequest });
        List<DataCuratorDuplicatePlanAction.Response> duplicateResponses =
            DataCuratorDuplicatePlanAction.run(
                new List<DataCuratorDuplicatePlanAction.Request>{ duplicateRequest }
            );
        List<DataCuratorGovSummaryAction.Response> govSummaryResponses =
            DataCuratorGovSummaryAction.run(
                new List<DataCuratorGovSummaryAction.Request>{ govSummaryRequest }
            );
        List<DataCuratorStaleBriefAction.Response> staleBriefResponses =
            DataCuratorStaleBriefAction.run(
                new List<DataCuratorStaleBriefAction.Request>{ staleBriefRequest }
            );
        List<DataCuratorOwnerNoteAction.Response> ownerNoteResponses =
            DataCuratorOwnerNoteAction.run(
                new List<DataCuratorOwnerNoteAction.Request>{ ownerNoteRequest }
            );
        List<DataCuratorCleanupBriefAction.Response> cleanupBriefResponses =
            DataCuratorCleanupBriefAction.run(
                new List<DataCuratorCleanupBriefAction.Request>{ cleanupBriefRequest }
            );
        Test.stopTest();

        System.assertEquals(1, inventoryResponses.size());
        System.assertEquals('Finance', inventoryResponses[0].department_filter_used);
        System.assertEquals(1, staleResponses[0].critical_asset_count);
        System.assertNotEquals(null, proposalResponses[0].recommended_owner_id);
        System.assertNotEquals(null, assignmentResponses[0].audit_record_id);
        System.assertEquals(1, duplicateResponses[0].duplicate_cluster_count);
        System.assert(govSummaryResponses[0].promptResponse.contains('Executive Summary'));
        System.assert(staleBriefResponses[0].promptResponse.contains('Stale Metadata Brief'));
        System.assert(ownerNoteResponses[0].promptResponse.contains('Security Auth Logs'));
        System.assert(cleanupBriefResponses[0].promptResponse.contains('Duplicate Cleanup Summary'));
    }

    private static User createUser(String userKey) {
        Profile profileRecord = [SELECT Id FROM Profile WHERE Id = :UserInfo.getProfileId() LIMIT 1];
        String uniqueFragment = String.valueOf(Crypto.getRandomInteger()).replace('-', '');
        User testUser = new User(
            Alias = userKey.substring(userKey.length() - 3),
            Email = userKey + '@example.com',
            EmailEncodingKey = 'UTF-8',
            LastName = 'Curator',
            LanguageLocaleKey = 'en_US',
            LocaleSidKey = 'en_US',
            ProfileId = profileRecord.Id,
            TimeZoneSidKey = 'America/New_York',
            UserName = userKey + '.' + uniqueFragment + '@example.com'
        );
        insert testUser;
        return testUser;
    }
}
