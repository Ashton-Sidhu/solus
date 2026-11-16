// Adapted from T3 Code apps/mobile/src/features/threads/NewTaskRouteScreen.tsx (MIT, see UPSTREAM.md).
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../navigation/routes";
import { ScreenHeader } from "../../components/ScreenHeader";

type Navigation = NativeStackNavigationProp<RootStackParamList>;

export function NewTaskHeader(props: {
  readonly title: string;
  readonly canAddProject: boolean;
  readonly searchText: string;
  readonly onAddProject: () => void;
  readonly onSearchTextChange: (text: string) => void;
}) {
  const navigation = useNavigation<Navigation>();
  return (
    <ScreenHeader
      title={props.title}
      sidebar={false}
      backInSplitView={{
        accessibilityLabel: "Go back",
        icon: "chevron.left",
      }}
      hideBottomBorder
      onBack={() => navigation.goBack()}
      actions={
        props.canAddProject
          ? [
              {
                accessibilityLabel: "Add project",
                icon: "plus",
                onPress: props.onAddProject,
              },
            ]
          : []
      }
      search={{
        value: props.searchText,
        onChangeText: props.onSearchTextChange,
        placeholder: "Search projects",
      }}
    />
  );
}

